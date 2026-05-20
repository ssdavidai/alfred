---
type: account
status: active # active | suspended | closed | pending
name:
description:
account_type: # financial | service | platform | subscription
provider: # Link to Org (who provides this account)
managed_by: # Link to Person (who has access/responsibility)
project: # Link to Project (if project-specific)
account_id: # Account number, username, or identifier
cost: # Monthly/annual cost if applicable
renewal_date:
credentials_location: # Where credentials are stored (e.g., password manager path)
related: []
relationships: []
created: "{{date}}"
tags: []
---

# {{title}}

## Details

<!-- Account specifics — what it's for, access level, any limitations -->

## Related
![[account.base#Assets]]
![[account.base#Related]]
