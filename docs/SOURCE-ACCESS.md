# Source access — evidence and first experiments

Last researched September 5, 2026. Owner: Shaw; Ben owns authorization, credentials and persistence. Documentation availability is not proof our app has access. **No provider is marked operationally verified by this planning pack.**

## Google sign-in — documented, integration untested

Basic OpenID Connect gives account identity/email and potentially profile fields. Contacts/mail need separate authorization. Ben verifies tokens and keeps a stable subject ID; never use email alone as immutable account identity. [Official reference](https://developers.google.com/identity/openid-connect/reference).

## Google Contacts — primary automated candidate, untested

People API `people.connections.list` with `contacts.readonly` provides the authenticated user's contacts with pagination and requested available fields. It does not reveal contacts' contacts. Record names, organizations/roles and profile URLs only when present; saved phone contacts are available only if actually in that Google account. A record is CONTACT_SAVED, not close friendship. First experiment: one owner grants read access; Shaw reports count, page count, populated field ratios, errors and time; Ben persists one private batch. [People API](https://developers.google.com/people/api/rest/v1/people.connections/list).

Google Other Contacts is a possible extension with separate permission and narrower available fields. Agree on provider enum/contract with Ben first. [Other Contacts](https://developers.google.com/people/api/rest/v1/otherContacts/list).

## LinkedIn export — documented, actual file untested

Ask a participating account owner to request their connection archive immediately. Inspect the received file before promising filenames or employer/email columns. Some connection emails are excluded according to their settings. This export cannot supply arbitrary second-degree networks. [Official export instructions](https://www.linkedin.com/help/linkedin/answer/a566336/export-connections-from-linkedin).

Connections API is restricted to approved developers; it returns first-degree connections for the consenting member, not their contacts' contacts. Status: BLOCKED unless the team demonstrates approval. A LinkedIn sign-in token is not proof of this permission. [Connections API](https://learn.microsoft.com/en-us/linkedin/shared/integrations/people/connections-api).

## Instagram export — investigate actual account/file

Meta offers account data export through Accounts Center. The team must verify which follower/following records arrive and their actual shape before promising an adapter. Preserve direction and source timestamp. Counts, profile ownership and follower-list availability are different capabilities. [Meta account information tools](https://about.fb.com/news/2023/10/manage-your-information-across-apps/).

Meta's official Instagram collection focuses on professional accounts; its Facebook Login API cannot access consumer accounts. We have not verified a general consumer-account mutuals endpoint. Status for live arbitrary mutual lookup: UNVERIFIED; do not make the critical path depend on it. [Official Meta API collection](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api).

## Public profile/username discovery — optional investigation

Sherlock searches usernames across sites. It is not a reliable email-to-Instagram resolver, proof that matched profiles belong to one human, or a source of their interpersonal connections. Use voluntarily supplied handles or public profile links, bounded source checks, evidence and user review. Unsupported sites/false positives/blocked pages remain unknown. Never use password recovery or leaked databases as enrichment. [Sherlock source](https://github.com/sherlock-project/sherlock).

## Gmail metadata — deferred

Gmail metadata scope is restricted even without message bodies. Source-policy/use-case and verification constraints need separate review before fetching or pooling derived data. Email frequency and recipients are signals, not friendship proof; bulk-mail co-recipients must not become cliques. [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), [Workspace data policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy).

## Test audience

Google testing mode supports up to 100 designated test users, with seven-day authorizations for the additional scopes relevant here. This enables a controlled tested demo; it does not establish public-release approval. [Google audience rules](https://support.google.com/cloud/answer/15549945?hl=en).

## Shaw's capability report (counts only)

```text
Provider:
Status: VERIFIED / AVAILABLE_BUT_UNTESTED / BLOCKED / UNSUPPORTED
Actual access method and permission:
Tested at:
Record/page counts:
Available fields and missing-field rates:
Actual link semantics:
Pagination/rate limits/errors observed:
Privacy/source-use constraints:
Private sample reference (not raw data):
Next task and fallback:
```

Only mark VERIFIED after an actual authorized request/file is normalized and validated end-to-end. If empty, report zero records; never manufacture a sample network. Each source may fail independently. Tokens, account IDs, contacts and raw exports belong outside this public repository and count-only reports.
