# User Profile

The `user-profile.md` file helps Alfred understand who you are and what's relevant to your vault. It lives in your vault root directory and is created automatically during `alfred quickstart`.

## Why It Matters

Without a user profile, the curator extracts entities for everything mentioned in your notes — including TV shows you analyzed, historical figures you referenced, and third-party products you compared. This creates noise in your vault.

With a user profile, the curator understands your context and only creates records for entities you directly interact with: your projects, your colleagues, your clients, your tools.

## Location

```
your-vault/
  user-profile.md      <-- here
  inbox/
  project/
  person/
  ...
```

## Template

The quickstart wizard creates this template:

```markdown
# User Profile

This file helps Alfred understand who you are so it can make better decisions
about what's relevant to your vault.

## About Me
<!-- Your name, role, and what you do -->

## My Work
<!-- What projects are you working on? What's your profession?
     Who do you work with? -->

## My Interests
<!-- What topics, domains, or areas are you actively engaged in? -->

## What's NOT Relevant
<!-- Anything you want Alfred to explicitly ignore or skip? -->
```

## Example

```markdown
# User Profile

## About Me
I'm Jane Chen, a product manager at Acme Corp. Based in San Francisco.

## My Work
- Leading the Acme Platform v3 migration
- Managing the API Integration project with partner companies
- Working with the Mobile team on the new iOS app
- Key collaborators: Tom Rodriguez (engineering lead), Sarah Kim (design),
  Mike Chen (our CTO)

## My Interests
- Product management methodologies
- API design and developer experience
- Mobile app architecture
- Team management and hiring

## What's NOT Relevant
- I read a lot about history and philosophy for fun — don't create
  records for historical figures or philosophical concepts
- I follow tech news but don't need records for companies I just
  read about (only companies I work with)
```

## How It's Used

The curator's Stage 1 prompt includes the user profile content. When the LLM analyzes an inbox file and decides which entities to extract, it uses the profile to determine relevance:

- A note mentioning "Alexander the Great" in an analogy will NOT create a person record
- A note mentioning "Tom Rodriguez reviewed the API spec" WILL create a person record
- A note analyzing competitor products will NOT create project records for those products
- A note about "started the Platform v3 migration" WILL create or link to that project

## Fallback Behavior

If `user-profile.md` is missing or empty, Alfred falls back to general-purpose extraction with reasonable defaults. It will still filter obvious noise (media references, celebrities) but won't have personal context for more nuanced decisions.

## Alternative Locations

Alfred searches for the user profile in this order:
1. `{vault_path}/user-profile.md` (primary)
2. `~/.config/alfred/user-profile.md` (fallback)
