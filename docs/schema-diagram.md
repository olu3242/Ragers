# Ragers — Data Model / Schema Diagram

**Classification:** Internal — do not publish or link from public surfaces.

This is the core relational data model behind Ragers, covering the entities needed for posting, reacting, reporting, and moderation. It intentionally omits any proprietary scoring/ranking internals (trust-score calculation, moderation-routing logic) — those live in separate internal architecture docs, not here. A rendered version of this diagram is in `schema-diagram.svg`.

## Entity-relationship diagram

```mermaid
erDiagram
    USER ||--o{ POST : creates
    USER ||--o{ ALIAS : owns
    USER ||--o{ REACTION : gives
    USER ||--o{ FAIR_VOTE : casts
    USER ||--o{ REPORT : files

    POST ||--o{ MEDIA : includes
    POST ||--o{ REACTION : receives
    POST ||--o{ FAIR_VOTE : receives
    POST ||--o{ REPORT : receives
    POST ||--o{ SHARE_CARD : generates
    POST ||--o{ MODERATION_ACTION : triggers
    POST }o--|| CATEGORY : tagged_with

    USER {
        uuid id PK
        string email
        string auth_provider
        string default_visibility
        datetime created_at
        datetime last_active_at
    }

    ALIAS {
        uuid id PK
        uuid user_id FK
        string alias_name
        boolean is_active
        datetime created_at
    }

    POST {
        uuid id PK
        uuid user_id FK
        uuid category_id FK
        string type "rager | rave"
        string visibility "public | alias | anonymous"
        text body_text
        string status "active | removed | under_review"
        datetime created_at
    }

    MEDIA {
        uuid id PK
        uuid post_id FK
        string original_url "internal only, never public"
        string protected_url "public-facing, identity protected"
        string protection_status "pending | protected | failed"
        datetime created_at
    }

    REACTION {
        uuid id PK
        uuid post_id FK
        uuid user_id FK
        string reaction_type
        datetime created_at
    }

    FAIR_VOTE {
        uuid id PK
        uuid post_id FK
        uuid user_id FK
        boolean is_fair
        datetime created_at
    }

    REPORT {
        uuid id PK
        uuid post_id FK
        uuid reporter_user_id FK
        string reason_code
        string status "open | reviewed | closed"
        datetime created_at
    }

    MODERATION_ACTION {
        uuid id PK
        uuid post_id FK
        uuid moderator_id FK
        string action "warn | remove | restore | no_action"
        string reason
        datetime created_at
    }

    SHARE_CARD {
        uuid id PK
        uuid post_id FK
        string image_url
        integer share_count
        datetime created_at
    }

    CATEGORY {
        uuid id PK
        string name
        string parent_category
    }
```

## Notes

- `MEDIA.original_url` is never exposed on any public API response or public page — only `protected_url` (post identity-protection processing) is public-facing. This maps directly to the "Identity Protected" promise on the landing page.
- `POST.visibility = anonymous` means no `user_id` is exposed in any public API response for that post, even though the row retains it internally for moderation/abuse purposes.
- `ALIAS` is separate from `USER` so a user can maintain more than one alias, each with its own posting history, without those histories being publicly linkable to each other or to the underlying account.
- `MODERATION_ACTION` and the internal fields on `REPORT`/`MEDIA` are examples of exactly the kind of implementation detail that must stay out of public copy — see `CLAUDE.md`.
- This model deliberately excludes any proprietary scoring/weighting fields (e.g. how `FAIR_VOTE` and `REACTION` data feed into any internal trust or ranking system) — that logic is out of scope for this document and lives in internal architecture material.
