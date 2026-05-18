"""Transaction clustering for Sure self-hosted finance.

Sister of `clustering.py` (which clusters email senders). This module
takes a list of Sure transactions and produces a list of *cluster
proposals* — each proposal is one canonical merchant + one suggested
category + one optional tag, with sample member names and a confidence.

Pipeline:

  1.  Clean each transaction name (strip postcodes, currency tokens,
      reference numbers, normalise whitespace).
  2.  TF-IDF over character 3-5 grams of cleaned names.
  3.  Agglomerative clustering on cosine distance with a fixed
      threshold (default 0.4) → alias groups. "TESCO" / "Tesco 41520" /
      "BUDAORS TESCO" collapse into one group; "FoodCo" stays separate.
  4.  For each alias group, build per-group features (txn count,
      monthly regularity, amount_z, currency mix, account diversity,
      recency).
  5.  HDBSCAN on per-group features → behavioural cluster_id (used for
      tagging similar groups, e.g. all "small recurring USD
      subscriptions"). Optional: when n_groups < 20 we skip and emit
      cluster_id=-1.
  6.  Per group, infer category by keyword lookup on the canonical
      name. Compute confidence from amount stability + member coverage.

The output is intentionally *proposals* — not writes. The caller
(ctrl-api `/api/v1/sure/_cluster_apply`) is responsible for creating
the FamilyMerchants, rules, and triggering apply_all.

This module does NOT touch any external services. Pure compute.

Source-of-truth for category names + ids is the caller — we return
category *names* (e.g. "Groceries") and the caller resolves to ids.
"""

from __future__ import annotations

import logging
import re
from collections import Counter, defaultdict
from dataclasses import dataclass, asdict
from datetime import datetime
from typing import Any, Iterable

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Cleaning
# ---------------------------------------------------------------------------

_NOISE_TOKENS = re.compile(
    r"\b(VISA|MC|MASTERCARD|ATM|POS|HUF|EUR|USD|GBP|CHF|JPY|REF|TRANS|TXN|HU|UK|CARD|"
    r"PURCHASE|PAYMENT|PURCH|TRF|TRANSFER|TO|FROM|FOR|VIA|ON|AT|TR|DOM|INT|FX|BAL|TXNREF)\b",
    re.IGNORECASE,
)
_CARD_NUMBERS = re.compile(r"\b(?:\*{2,}\s*\d+|\d{4,}\s*\*{4,}|5\d{3}\s+\*{4})\b")
# Strip ALL digit runs (no word boundary) so "Obi010Budaors" → "obi budaors"
# and the regex `\bobi\b` matches in the cleaned form.
_ANY_DIGITS = re.compile(r"\d+")
_PUNCT = re.compile(r"[^a-z0-9\s]+")
_WHITESPACE = re.compile(r"\s+")
_TINY_TOKEN = re.compile(r"\b[a-z]{1,2}\b")


def clean_name(raw: str | None) -> str:
    """Return a noise-stripped lowercase form of a bank-feed name string.

    Drops postcodes, card numbers, long digit sequences, common bank
    noise tokens (VISA/HUF/etc.), punctuation, and 1-2 character
    leftover tokens (e.g. "o", "sz") that confuse alias clustering.
    """
    if not raw:
        return ""
    n = raw.lower()
    n = _CARD_NUMBERS.sub(" ", n)
    n = _NOISE_TOKENS.sub(" ", n)
    n = _ANY_DIGITS.sub(" ", n)
    n = _PUNCT.sub(" ", n)
    n = _TINY_TOKEN.sub(" ", n)
    n = _WHITESPACE.sub(" ", n).strip()
    return n


# ---------------------------------------------------------------------------
# Category inference (keyword → category name)
# ---------------------------------------------------------------------------

# Each entry: (regex_in_cleaned_name, category, optional tag, role)
# role: "merchant" | "transfer" | "income" | "fee"
DEFAULT_CATEGORY_RULES: list[tuple[str, str, str | None, str]] = [
    # Groceries
    (r"\btesco\b", "Groceries", "Grocery", "merchant"),
    (r"\baldi\b", "Groceries", "Grocery", "merchant"),
    (r"\blidl\b", "Groceries", "Grocery", "merchant"),
    (r"\bspar\b", "Groceries", "Grocery", "merchant"),
    (r"\bauchan\b", "Groceries", "Grocery", "merchant"),
    (r"\bcba\b", "Groceries", "Grocery", "merchant"),
    (r"\bpenny\b", "Groceries", "Grocery", "merchant"),
    (r"\bcoop\b", "Groceries", "Grocery", "merchant"),
    (r"\bkifli\b", "Groceries", "Grocery", "merchant"),
    # Food & Drink
    (r"\bwolt\b", "Food & Drink", "Food Delivery", "merchant"),
    (r"\bfoodora\b", "Food & Drink", "Food Delivery", "merchant"),
    (r"\bbolt\s*food\b", "Food & Drink", "Food Delivery", "merchant"),
    (r"\bstarbucks\b", "Food & Drink", None, "merchant"),
    (r"\bmcdonald|\bmcd\b", "Food & Drink", None, "merchant"),
    (r"\bkfc\b", "Food & Drink", None, "merchant"),
    (r"\bkebab\b", "Food & Drink", None, "merchant"),
    # Personal Care
    (r"\brossmann\b", "Personal Care", None, "merchant"),
    (r"\bdrogerie\b|\bdm\b", "Personal Care", None, "merchant"),
    (r"\bnotino\b", "Personal Care", None, "merchant"),
    (r"\bbliss\b.*\bbody\b|\bbliss\s*body\b", "Personal Care", None, "merchant"),
    # Subscriptions
    (r"\bnetflix\b", "Subscriptions", "Subscription", "merchant"),
    (r"\bspotify\b", "Subscriptions", "Subscription", "merchant"),
    (r"\bapple\.?com\b|\bitunes\b", "Subscriptions", "Subscription", "merchant"),
    (r"\bopenai\b|\bchatgpt\b", "Subscriptions", "Subscription", "merchant"),
    (r"\banthropic\b|\bclaude\.ai\b|\bclaude\b", "Subscriptions", "Subscription", "merchant"),
    (r"\b1password\b", "Subscriptions", "Subscription", "merchant"),
    (r"\bgsuite\b|\bgoogle\W*workspace\b", "Subscriptions", "Subscription", "merchant"),
    (r"\bgoogle\W*one\b", "Subscriptions", "Subscription", "merchant"),
    (r"\bgithub\b", "Subscriptions", "Subscription", "merchant"),
    (r"\bvercel\b", "Subscriptions", "Subscription", "merchant"),
    (r"\bsupabase\b", "Subscriptions", "Subscription", "merchant"),
    (r"\bdisney\b", "Subscriptions", "Subscription", "merchant"),
    (r"\bprime\W*video\b", "Subscriptions", "Subscription", "merchant"),
    (r"\bdropbox\b", "Subscriptions", "Subscription", "merchant"),
    (r"\bdashlane\b", "Subscriptions", "Subscription", "merchant"),
    (r"\bappsumo\b", "Subscriptions", "Subscription", "merchant"),
    (r"\bplex\b|plexinc\b", "Subscriptions", "Subscription", "merchant"),
    (r"name\W?cheap", "Subscriptions", "Subscription", "merchant"),
    (r"\bcanva\b", "Subscriptions", "Subscription", "merchant"),
    (r"\blovable\b", "Subscriptions", "Subscription", "merchant"),
    (r"\bhetzner\b", "Subscriptions", "Subscription", "merchant"),
    (r"\bopenai|chatgpt", "Subscriptions", "Subscription", "merchant"),
    (r"\bsuno\b", "Subscriptions", "Subscription", "merchant"),
    (r"\breplicate\b", "Subscriptions", "Subscription", "merchant"),
    (r"\bopenrouter\b", "Subscriptions", "Subscription", "merchant"),
    (r"\bcontabo\b", "Subscriptions", "Subscription", "merchant"),
    (r"\bzoom\b", "Subscriptions", "Subscription", "merchant"),
    (r"\bmiro\b", "Subscriptions", "Subscription", "merchant"),
    (r"\belevenlabs\b", "Subscriptions", "Subscription", "merchant"),
    (r"\bnabu\W*casa\b", "Subscriptions", "Subscription", "merchant"),
    (r"\bremarkable\b", "Subscriptions", "Subscription", "merchant"),
    (r"\bmake\.com\b|\bpromptmast\b", "Subscriptions", "Subscription", "merchant"),
    (r"\bmicrosoft\W*\d*\W*(?:365|office)\b", "Subscriptions", "Subscription", "merchant"),
    # Sports & Fitness / Entertainment
    (r"\bwhoop\b", "Sports & Fitness", None, "merchant"),
    (r"\bdecathlon\b", "Sports & Fitness", None, "merchant"),
    (r"\bsziget\b", "Entertainment", None, "merchant"),
    (r"\bcinema\W*city\b", "Entertainment", None, "merchant"),
    # Transportation
    (r"\bbolt\.eu\b", "Transportation", "Transport", "merchant"),
    (r"\buber\b", "Transportation", "Transport", "merchant"),
    (r"\bmol\b", "Transportation", "Transport", "merchant"),
    (r"\bshell\b", "Transportation", "Transport", "merchant"),
    (r"\bomv\b", "Transportation", "Transport", "merchant"),
    (r"\bbkk\b|\bbkv\b", "Transportation", "Transport", "merchant"),
    (r"\bparkol|\bparking\b", "Transportation", "Transport", "merchant"),
    # Travel
    (r"\bairport\b|\bairlines?\b|\bbooking\.com\b|\bairbnb\b", "Travel", None, "merchant"),
    # Utilities
    (r"\btelekom\b", "Utilities", "Hungarian Utility", "merchant"),
    (r"\bvodafone\b", "Utilities", "Hungarian Utility", "merchant"),
    (r"\bmvm\b|\belmu\b|\baram\b", "Utilities", "Hungarian Utility", "merchant"),
    (r"\bfogaz\b", "Utilities", "Hungarian Utility", "merchant"),
    (r"\bvizmu\b|\bvizmuvek\b", "Utilities", "Hungarian Utility", "merchant"),
    (r"\bstarlink\b", "Utilities", None, "merchant"),
    # Healthcare
    (r"\bpatika\b|\bpharmacy\b|\bgyogyszertar\b", "Healthcare", "Healthcare", "merchant"),
    (r"\bmedical\b|\bdoktor\b|\bklinika\b|\borvosi\b", "Healthcare", "Healthcare", "merchant"),
    (r"\bbioexpert\b|\bpireno\b|\bwmc\b", "Healthcare", "Healthcare", "merchant"),
    # Home Improvement / Shopping
    (r"\bikea\b", "Home Improvement", None, "merchant"),
    (r"\bpraktiker\b", "Home Improvement", None, "merchant"),
    (r"\bobi\b", "Home Improvement", None, "merchant"),
    (r"\bamazon\b|\bamzn\b", "Shopping", None, "merchant"),
    (r"\bbrendon\b", "Shopping", "Child / Baby", "merchant"),
    (r"\bgyermekugyel\b|\bbaba\b", "Healthcare", "Child / Baby", "merchant"),
    (r"\bpepco\b", "Shopping", None, "merchant"),
    (r"\bsinsay\b", "Shopping", None, "merchant"),
    # Investments
    (r"\brobo\W*portfolio\b", "Investment Contributions", None, "merchant"),
    (r"\bvault\b.*\b(deposit|allocation)\b", "Savings & Investments", None, "merchant"),
    # Taxes / Government
    (r"\bfoldhivatal\b|\budyfelkapu\b|\bnav\b|\baliami\b", "Taxes", None, "merchant"),
    # Fees
    (r"\bmetal\W*repricing\b|\bcard\s*fee\b|\bservice\s*charge\b", "Fees", None, "fee"),
    # Income (Hungarian "fizetés"/"fizető" salary variants — match the prefix)
    (r"\bsalary\b|\bfizet|\bpayroll\b", "Income", "Salary / Income", "income"),
    (r"\bcsed\b|\bgyed\b|\ballamkincstar\b", "Income", "Salary / Income", "income"),
    (r"\brefund\b|\bvisszateritest?\b", "Income", None, "income"),
    # Loan / Mortgage
    (r"\bcib\b.*\belorelep\b|\belorelep\b", "Loan Payments", None, "merchant"),
    (r"\bjbc\b|\bjelzalog\b|\bmortgage\b", "Mortgage / Rent", None, "merchant"),
    # Internal transfers — Example Bank, Example Bank, Example Bank, Apple/Google Pay
    (r"\bwise\b", "Transfers", "Transfer", "transfer"),
    (r"\bexchanged?\b.*\bto\b|\bcurrency\W*exchange\b", "Transfers", "Transfer", "transfer"),
    (r"\brevolut\b", "Transfers", "Transfer", "transfer"),
    (r"\bvault\b.*\b(transfer|in|out)\b|\brevolut\W*vault\b", "Transfers", "Transfer", "transfer"),
    (r"\bpay\W*top\W*up\b|\btop[\W_]*up\b.*\bby\b", "Transfers", "Transfer", "transfer"),
    (r"\berste\W*bank\b", "Transfers", "Transfer", "transfer"),
    (r"\bstripe\b.*\btransfer\b", "Transfers", "Transfer", "transfer"),
    # Self-name transfers (Hungarian variations of "Sir/Sam Lee Szabó-Stubán")
    (r"\bdavid\b.*\bszabo\b|\bszabo\b.*\bstuban\b|\bszab[oó]\W*stub[aá]n\b", "Transfers", "Transfer", "transfer"),
    (r"\beszter\b.*\bszabo\b|\beszter\b.*\bstuban\b", "Transfers", "Transfer", "transfer"),
    # Cashback/balance lines (Example Bank interest, top-ups, balance adjustments)
    (r"\bbalance\W*[-_]?cashback\b|\bbalance[-_]\d+\b|\bcashback\b", "Income", None, "income"),
    # Hungarian Telekom abbreviation in bank descriptions
    (r"\btelekomszaml\b", "Utilities", "Hungarian Utility", "merchant"),
]


def _compile_rules(rules: list[tuple[str, str, str | None, str]]) -> list[tuple[re.Pattern[str], str, str | None, str]]:
    return [(re.compile(rx, re.IGNORECASE), cat, tag, role) for rx, cat, tag, role in rules]


# ---------------------------------------------------------------------------
# Per-group feature extraction
# ---------------------------------------------------------------------------


def _signed_huf(t: dict[str, Any], fx: dict[str, float]) -> float:
    """Convert signed_amount_cents to HUF major-unit, family-currency-agnostic.

    Sure stores HUF as raw integer in `signed_amount_cents` (HUF has no
    subunit). For other currencies, signed_amount_cents is in 1/100 of
    the major unit. We normalise everything to HUF using a static rate
    table — accurate enough for clustering features (we only care about
    relative magnitude).
    """
    sac = t.get("signed_amount_cents", 0) or 0
    cur = t.get("currency", "HUF")
    if cur == "HUF":
        return float(sac)
    rate = fx.get(cur, 0.0)
    return (sac / 100.0) * rate


_DEFAULT_FX = {
    "HUF": 1.0,
    "USD": 350.0,
    "EUR": 400.0,
    "GBP": 460.0,
    "CHF": 420.0,
    "JPY": 2.4,
}


def _alias_groups(
    cleaned_names: list[str],
    similarity_threshold: float = 0.4,
    min_doc: int = 1,
) -> list[int]:
    """Return a cluster label per input name using TF-IDF word tokens.

    Bank-feed names have two failure modes for clustering:
      1. Anchor-word variants: "Tesco 41520", "BUDAORS TESCO" — these
         should merge.
      2. Payment-processor prefixes: "Simplep*online.auchan",
         "Simplep*telekom" — these should *split* by their second
         token (auchan vs telekom), not collapse on "simplep".

    TF-IDF on word tokens handles both naturally: high-frequency tokens
    like "simplep" get low IDF weight, so the cosine similarity of
    "simplep auchan" vs "simplep telekom" is dominated by the
    *distinctive* tokens (auchan, telekom). Conversely, "tesco" is
    moderate-frequency and correctly merges its variants.

    Char-ngrams were tried first and over-split on the Tesco family
    because two short docs with one shared word still register as
    distant. Word-level TF-IDF + agglomerative cosine is the right
    granularity for bank-feed strings.
    """
    docs = [n if n else "" for n in cleaned_names]
    n = len(docs)
    if n <= 1:
        return [0] * n

    # Filter out docs with zero usable tokens — they get assigned to
    # their own singleton clusters at the end.
    has_content = [bool([t for t in d.split() if len(t) >= 3]) for d in docs]
    keep_indices = [i for i, ok in enumerate(has_content) if ok]
    if not keep_indices:
        return list(range(n))

    sub_docs = [docs[i] for i in keep_indices]

    # On small corpora (< 50 docs) TF-IDF degenerates because IDF is
    # zero for any token that appears in every doc — so the cosine
    # similarity collapses to the noise tokens. For these, do
    # token-overlap merging: docs that share any token of length >= 4
    # merge into one cluster (transitively).
    if len(sub_docs) < 50:
        sub_labels = _shared_token_merge(sub_docs)
    else:
        sub_labels = _tfidf_agglomerative(
            sub_docs, similarity_threshold=similarity_threshold, min_doc=min_doc
        )

    # Stitch back into the full label vector. Empty docs each get
    # their own unique label so they form singleton clusters that
    # the caller can drop via min_group_size.
    next_id = max(sub_labels) + 1 if sub_labels else 0
    labels: list[int] = [0] * n
    for k, idx in enumerate(keep_indices):
        labels[idx] = sub_labels[k]
    for i in range(n):
        if not has_content[i]:
            labels[i] = next_id
            next_id += 1
    return labels


def _shared_token_merge(docs: list[str], min_token_len: int = 4) -> list[int]:
    """Cluster docs that share at least one token of length >= min_token_len.

    Uses union-find for transitive merging. Used as a small-corpus
    shortcut when TF-IDF math degenerates (n_docs too small for
    meaningful IDF).
    """
    n = len(docs)
    parent = list(range(n))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    # For each useful token, merge all docs that contain it.
    token_to_docs: dict[str, list[int]] = defaultdict(list)
    for i, d in enumerate(docs):
        for t in {tok for tok in d.split() if len(tok) >= min_token_len}:
            token_to_docs[t].append(i)
    for token, indices in token_to_docs.items():
        if len(indices) < 2:
            continue
        for j in indices[1:]:
            union(indices[0], j)

    # Compress paths and assign sequential cluster ids
    roots = {find(i): None for i in range(n)}
    label_of_root: dict[int, int] = {}
    next_id = 0
    for r in roots:
        label_of_root[r] = next_id
        next_id += 1
    return [label_of_root[find(i)] for i in range(n)]


def _tfidf_agglomerative(
    docs: list[str], similarity_threshold: float, min_doc: int
) -> list[int]:
    """TF-IDF on word tokens (>=3 chars) + agglomerative cosine."""
    if len(docs) <= 1:
        return [0] * len(docs)
    try:
        from sklearn.feature_extraction.text import TfidfVectorizer
        from sklearn.cluster import AgglomerativeClustering
    except ImportError:
        logger.warning("sklearn unavailable; falling back to identity grouping")
        return list(range(len(docs)))

    vec = TfidfVectorizer(
        analyzer="word",
        token_pattern=r"(?u)\b\w{3,}\b",
        min_df=min_doc,
        sublinear_tf=True,
    )
    try:
        matrix = vec.fit_transform(docs)
    except ValueError:
        return list(range(len(docs)))

    if matrix.shape[0] < 2 or matrix.shape[1] == 0:
        return [0] * matrix.shape[0]

    clusterer = AgglomerativeClustering(
        n_clusters=None,
        metric="cosine",
        linkage="average",
        distance_threshold=similarity_threshold,
    )
    return [int(x) for x in clusterer.fit_predict(matrix.toarray())]


def _canonical_name_for_group(member_names: list[str]) -> str:
    """Pick the most representative cleaned name for a group.

    Strategy: most common first-token. Falls back to the longest name.
    """
    if not member_names:
        return ""
    tokens = Counter()
    for n in member_names:
        first = (n.split() or [""])[0]
        if first:
            tokens[first] += 1
    if tokens:
        token = tokens.most_common(1)[0][0]
        return token.title()
    # Fallback: longest cleaned name
    return max(member_names, key=len).title()


def _classify_group(
    canonical: str,
    members: list[str],
    compiled_rules: list[tuple[re.Pattern[str], str, str | None, str]],
) -> tuple[str | None, str | None, str | None]:
    """Look up (category_name, tag_name, role) for a group's canonical name.

    Tests each rule against:
      1. The canonical name (clean Title-cased form).
      2. Each raw member name (preserves digits, casing, punctuation
         that bank descriptions carry).
      3. Each cleaned member name (digits stripped — needed when the
         merchant name is fused with digits like "Obi010Budaors" where
         the raw form has no word boundary around "obi").

    First match wins. Stop early.
    """
    raw = members[:5]
    cleaned = [clean_name(m) for m in raw]
    haystacks = [canonical] + raw + cleaned
    for h in haystacks:
        if not h:
            continue
        for rx, cat, tag, role in compiled_rules:
            if rx.search(h):
                return cat, tag, role
    return None, None, None


# ---------------------------------------------------------------------------
# Main entry
# ---------------------------------------------------------------------------


@dataclass
class ClusterProposal:
    canonical_name: str
    """Suggested FamilyMerchant name (Title-cased)."""
    pattern_keyword: str
    """Lowercase keyword to use as the LIKE filter on transaction_name."""
    proposed_category: str | None
    """Sure category name, or None if no rule matched."""
    proposed_tag: str | None
    """Tag name to attach, or None."""
    role: str
    """One of: merchant | transfer | income | fee | unknown."""
    member_names: list[str]
    """Up to 5 sample original names from this group."""
    txn_count: int
    total_volume_huf: float
    """Sum of |amount| converted to HUF for the group."""
    dominant_currency: str
    dominant_account: str
    monthly_regularity: float
    """Std-dev of inter-month gaps; lower = more regular."""
    confidence: float
    """0-1 — based on category match + amount stability + group size."""
    member_txn_ids: list[str]
    """Up to 50 sample txn IDs."""

    def asdict(self) -> dict[str, Any]:
        return asdict(self)


def cluster_transactions(
    txns: list[dict[str, Any]],
    *,
    similarity_threshold: float = 0.4,
    min_group_size: int = 2,
    rules: list[tuple[str, str, str | None, str]] | None = None,
    fx: dict[str, float] | None = None,
) -> list[ClusterProposal]:
    """Cluster a list of Sure transactions into proposed (merchant, rule) pairs.

    Args:
        txns: list of Sure transaction dicts (as returned by
            GET /api/v1/sure/transactions).
        similarity_threshold: cosine distance threshold for alias
            merging. 0.4 is reasonable for bank-feed strings.
        min_group_size: groups smaller than this are dropped.
        rules: keyword→category rules. Defaults to DEFAULT_CATEGORY_RULES.
        fx: currency→HUF conversion table. Defaults to _DEFAULT_FX.

    Returns:
        List of ClusterProposal sorted by txn_count descending.
    """
    if not txns:
        return []

    rules = rules if rules is not None else DEFAULT_CATEGORY_RULES
    fx = fx if fx is not None else _DEFAULT_FX
    compiled = _compile_rules(rules)

    # Step 1: clean each name
    cleaned = [clean_name(t.get("name") or "") for t in txns]

    # Step 2-3: alias clustering
    labels = _alias_groups(cleaned, similarity_threshold=similarity_threshold)

    # Step 4: build per-group features
    groups: dict[int, list[int]] = defaultdict(list)
    for i, lbl in enumerate(labels):
        groups[lbl].append(i)

    proposals: list[ClusterProposal] = []
    for lbl, indices in groups.items():
        if len(indices) < min_group_size:
            continue

        member_originals = [txns[i].get("name") or "" for i in indices]
        member_cleaned = [cleaned[i] for i in indices if cleaned[i]]
        if not member_cleaned:
            continue

        canonical = _canonical_name_for_group(member_cleaned)
        if not canonical:
            continue

        # Pattern keyword: most discriminating non-empty token
        keyword = (canonical.split() or [""])[0].lower()
        if not keyword or len(keyword) < 2:
            continue

        # Classify against RAW member names — many rules match noise
        # tokens (digits, "BALANCE-12345") that the cleaner strips.
        category, tag, role = _classify_group(canonical, member_originals, compiled)
        if role is None:
            role = "unknown"

        currencies = Counter(txns[i].get("currency", "?") for i in indices)
        accounts = Counter((txns[i].get("account") or {}).get("name", "?") for i in indices)
        dominant_currency = currencies.most_common(1)[0][0] if currencies else "HUF"
        dominant_account = accounts.most_common(1)[0][0] if accounts else "?"

        total_volume_huf = sum(abs(_signed_huf(txns[i], fx)) for i in indices)

        # Monthly regularity: std of inter-month gaps in days, default 0.0
        dates = sorted(
            d for d in (
                txns[i].get("date") for i in indices
            ) if d
        )
        regularity = 0.0
        if len(dates) >= 3:
            try:
                ds = [datetime.fromisoformat(d).date() for d in dates]
                gaps = [(ds[k] - ds[k - 1]).days for k in range(1, len(ds))]
                if gaps:
                    mean = sum(gaps) / len(gaps)
                    var = sum((g - mean) ** 2 for g in gaps) / len(gaps)
                    regularity = float(var ** 0.5)
            except Exception:
                pass

        # Confidence: 0.5 base + boost for category match + boost for size
        confidence = 0.3
        if category:
            confidence += 0.4
        if len(indices) >= 5:
            confidence += 0.15
        if len(indices) >= 20:
            confidence += 0.1
        confidence = min(confidence, 0.99)

        proposals.append(
            ClusterProposal(
                canonical_name=canonical,
                pattern_keyword=keyword,
                proposed_category=category,
                proposed_tag=tag,
                role=role,
                member_names=list(dict.fromkeys(member_originals))[:5],
                txn_count=len(indices),
                total_volume_huf=round(total_volume_huf, 2),
                dominant_currency=dominant_currency,
                dominant_account=dominant_account,
                monthly_regularity=round(regularity, 2),
                confidence=round(confidence, 2),
                member_txn_ids=[txns[i].get("id", "") for i in indices][:50],
            )
        )

    proposals.sort(key=lambda p: -p.txn_count)
    return proposals


def proposals_to_dicts(proposals: Iterable[ClusterProposal]) -> list[dict[str, Any]]:
    return [p.asdict() for p in proposals]


# ---------------------------------------------------------------------------
# Behavioural co-occurrence clustering
# ---------------------------------------------------------------------------
#
# Catches recurring patterns that name-clustering misses. Two transactions
# from the same account with the same magnitude (within ±5%) recurring
# monthly are almost certainly the same payee — even if the bank-feed
# strings are entirely different (e.g. "Sp Mind Lab Pro" / "Sp Mind Lab
# Pro Eu", or "MÓNIKA ARTAI" / "Acme Payee Bt." in different formats).
#
# Strategy:
#   1. Group transactions by (account_id, amount_band).
#       amount_band = round(abs(amount_huf) / 1000) * 1000 — a 1k-HUF
#       bucket — coarse enough that a 4,990 → 5,010 swing falls in the
#       same band.
#   2. Within a band, keep groups with N >= 3 occurrences spanning at
#       least 2 different months (otherwise it's a coincidence, not a
#       recurring pattern).
#   3. Emit one proposal per group with role=merchant or income
#       (depending on signed direction) and a synthetic canonical name
#       formed from the most common token across the group.


def behavioural_groups(
    txns: list[dict[str, Any]],
    *,
    min_occurrences: int = 3,
    min_months: int = 2,
    amount_band_huf: float = 1000.0,
    fx: dict[str, float] | None = None,
) -> list[ClusterProposal]:
    """Group transactions by (account, amount-band, monthly cadence).

    Returns proposals for behavioural clusters that wouldn't be caught
    by name-token clustering alone — i.e. recurring same-amount payments
    to differently-named entities.
    """
    fx = fx if fx is not None else _DEFAULT_FX
    if not txns:
        return []

    by_band: dict[tuple[str, float], list[int]] = defaultdict(list)
    for i, t in enumerate(txns):
        acct_id = (t.get("account") or {}).get("id") or "?"
        huf = _signed_huf(t, fx)
        if huf == 0:
            continue
        band = round(abs(huf) / amount_band_huf) * amount_band_huf
        # Skip very small bands (noise, fees) and very large (one-off purchases)
        if band < 1000 or band > 5_000_000:
            continue
        by_band[(acct_id, band)].append(i)

    proposals: list[ClusterProposal] = []
    for (acct_id, band), indices in by_band.items():
        if len(indices) < min_occurrences:
            continue
        months = {((txns[i].get("date") or "")[:7]) for i in indices}
        months.discard("")
        if len(months) < min_months:
            continue
        # Pick canonical from the most common cleaned name in the group
        cleaned = [clean_name(txns[i].get("name") or "") for i in indices]
        first_tokens = Counter(
            (c.split() or [""])[0] for c in cleaned if c
        )
        if not first_tokens:
            continue
        canonical_token = first_tokens.most_common(1)[0][0]
        if not canonical_token:
            continue

        # Determine role from signed direction: mostly outflows → merchant; mostly inflows → income
        positives = sum(1 for i in indices if (txns[i].get("signed_amount_cents", 0) or 0) > 0)
        negatives = len(indices) - positives
        role = "income" if positives > negatives else "merchant"

        member_originals = [txns[i].get("name") or "" for i in indices]
        accounts = Counter((txns[i].get("account") or {}).get("name", "?") for i in indices)
        currencies = Counter(txns[i].get("currency", "?") for i in indices)

        proposals.append(
            ClusterProposal(
                canonical_name=canonical_token.title(),
                pattern_keyword=canonical_token.lower(),
                proposed_category=None,  # left for LLM/human to decide
                proposed_tag=None,
                role=role,
                member_names=list(dict.fromkeys(member_originals))[:5],
                txn_count=len(indices),
                total_volume_huf=round(band * len(indices), 2),
                dominant_currency=currencies.most_common(1)[0][0],
                dominant_account=accounts.most_common(1)[0][0],
                monthly_regularity=0.0,  # placeholder; recurring by construction
                confidence=0.5,
                member_txn_ids=[txns[i].get("id", "") for i in indices][:50],
            )
        )

    proposals.sort(key=lambda p: -p.txn_count)
    return proposals
