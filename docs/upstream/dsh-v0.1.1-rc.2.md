# DSH upstream audit: v0.1.1-rc.1 and v0.1.1-rc.2

## Compared revisions

| Release | Commit | Role |
| --- | --- | --- |
| `dsh-v0.1.0-rc.8` | `141eb6fef83422698aef7a981029e843e8161534` | Previous dsh-code baseline |
| `dsh-v0.1.1-rc.1` | `528c682e061696f5a160f363f236ecbf53cbd006` | First new upstream release |
| `dsh-v0.1.1-rc.2` | `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` | Target release |

This audit separates kernel and service changes from Web-only presentation work. dsh-code consumes Harness runtime contracts and exposes only the parts that have a coherent terminal interaction.

## v0.1.1-rc.1

### Credential records and authorization flows

- Harness credentials now have two distinct stores:
  - environment-style references such as `DEEPSEEK_API_KEY`;
  - provider-owned records containing API-key or opaque grant data.
- The new `@deepseek-ai/dsh-authorization` service lets plugins register OAuth, device-code, interactive API-key, text, secret, and select flows without coupling the caller to a provider library.
- pi-ai providers can persist OAuth grants and interactive API keys, including OAuth-only routes such as OpenAI Codex.
- The legacy flat `.credentials.yaml` document is migrated automatically to the new `version` / `refs` / `records` layout.
- Breaking event rename: `credentials/updated` became `credentials/reference-updated`; record changes use `credentials/record-updated`.

dsh-code 1.0.1 mounts the authorization service and exposes these flows inside `/model`, while retaining manual API-key configuration.

### Session projection protocol

- Projection implementations now separate internal state from client wire views through `stateSchema` and optional `wire` definitions.
- Host-only state no longer has to be serialized to clients.
- Cached state is validated before reuse, and corrupted cache entries fall back to complete event replay.
- Projection units checkpoint uniformly.

dsh-code keeps its existing pure transcript projection for 1.0.1. Replacing only title, permission, goal, plan, or todo fields would create two state authorities while removing little code.

### Model and runtime changes

- The default DeepSeek model catalog adds `deepseek-v4-flash-vision-exp` with text and image input modalities.
- Linux bubblewrap profiles add PID namespace isolation to close `/proc/<pid>/root` escape paths.
- Final turn errors remain visible after retry exhaustion.
- Stable session snapshot work improves fixtures and replay verification without requiring a persisted-session migration.

### Changes not treated as kernel features

Multiline question editing, wide Markdown tables, subagent header switching, composer edit-range handling, and decimal cache display were primarily Web client changes. dsh-code independently adopts pasted multiline answers and decimal cache display where they fit the terminal.

rc.1 briefly added a writable default permission setting for blank sessions. rc.2 fully reverted that feature, so dsh-code does not depend on it.

## v0.1.1-rc.2

### Unified image storage and request pipeline

- Source images are normalized into provider-independent durable attachments before model dispatch.
- Default source admission expands to 20 MiB per image, 200 MiB per message, 64 million pixels, and an 8192-pixel source edge.
- Persisted images normalize orientation, metadata, color space, sample depth, animation input, and oversized dimensions; the default durable long edge is 2048 pixels.
- `ImageAttachmentRef.originalDimensions` records the orientation-applied source dimensions when normalization scales an image down.
- `readImageRequest(ref, policy)` creates deterministic model-specific image variants with bounded native processing and reusable `ImageVariantId` values.

### DeepSeek Files API

- DeepSeek Vision prefers uploaded Files references and reuses valid file ids.
- Upload identities are isolated by endpoint and credential scope.
- Expired, deleted, rejected, or quota-affected ids are invalidated and retried deliberately.
- Files resolution failure falls back for the whole request to inline data URLs; file and inline representations are never mixed in one request.
- Files and streaming timeouts are independent.
- The adapter does not currently publish an event when this fallback occurs, so dsh-code documents it but does not guess from logs or network behavior.

### Model capability and text-only behavior

- Exact model metadata carries input modalities and route-specific image budgets.
- A text-only model no longer rejects a conversation merely because earlier messages contain images. Durable image blocks become stable text placeholders for that request.
- `prepareCall()` binds capability resolution and dispatch to the same adapter generation, avoiding hot-configuration races.

dsh-code exposes the `image` capability in `/model`, warns before using text placeholders, and shows normalized and original image dimensions in transcript and export metadata.

### Configuration and compatibility

- The old DeepSeek setting `maxRequestImageBytes` is removed.
- DeepSeek image limits are now split between Files and inline request policies.
- Custom attachment implementations inherit a default rejecting `readImageRequest()` implementation; they must implement projection to serve vision requests.
- No persisted dsh-code session migration is required from rc.8.

## dsh-code 1.0.1 adoption

Implemented:

- exact `0.1.1-rc.2` dependency alignment;
- provider login, status, cancellation, logout, browser/device-code interaction;
- `@` image attachment and terminal image-drop conversion;
- image model labels, text-only warnings, and normalized metadata;
- credential event migration and retry-final-error coverage.

Deliberately retained:

- dsh-code's event-sourced transcript projection;
- existing manual API-key and provider settings workflows;
- silent upstream Files-to-inline fallback;
- historical 1.0.0 documentation describing rc.8.
