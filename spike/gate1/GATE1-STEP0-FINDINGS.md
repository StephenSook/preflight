# GATE 1 SPIKE — Step 0 findings (API surface), 2026-09-03

Every claim below carries the URL it came from and was verified FIRST-HAND, not from
training data and not on an agent's say-so. The machine-readable spec is saved to
`results/step0-evidence/voice-openapi-v1.json` (62,245 bytes, sha256 prefix `1a1056d0c297e8c2`).

Regenerate the spec evidence:

    python3 -c "import urllib.request;open('results/step0-evidence/voice-openapi-v1.json','wb').write(urllib.request.urlopen('https://developer.vonage.com/api/v1/developer/api/file/voice?format=json&vendorId=vonage').read())"

## 1. `canSpeak` / `canHear` take LEG UUIDs, and are join-time NCCO parameters

Source: <https://developer.vonage.com/en/voice/voice-api/ncco-reference>, `conversation` action table.

> `canSpeak` — "A list of leg UUIDs that this participant can be heard by. If not provided, the
> participant can be heard by everyone. If an empty list is provided, the participant will not be
> heard by anyone"

> `canHear` — "A list of leg UUIDs that this participant can hear. If not provided, the participant
> can hear everyone. If an empty list is provided, the participant will not hear any other participants"

**Leg UUIDs, confirmed — not member IDs.** The page's own worked example ("selective-audio-demo")
passes raw leg IDs such as `6a4d6af0-55a6-4667-be90-8614e4c8e83c`.

**The docs say NOTHING about updating them after join.** That silence is the whole reason for this spike.

Constraint that will bite a selective-routing design:
> `mute` — "...When using `canSpeak`, the `mute` parameter is not supported."

## 2. `PUT /v1/calls/{uuid}` — your list of six was CORRECT and COMPLETE

Authoritative spec: OpenAPI 3.0.0, `info.version` **1.10.0**, server `https://api.nexmo.com/v1/calls`.

The body is a `oneOf` over 7 schemas yielding 6 distinct actions:
`transfer` (NCCO variant), `transfer` (answer-URL variant), `hangup`, `mute`, `unmute`, `earmuff`, `unearmuff`.

Verbatim from the spec — and note each of the four audio schemas has **exactly one property**:

```json
"UpdateCallRequestEarmuff": {"title":"Earmuff","properties":{"action":{"type":"string",
  "example":"earmuff","enum":["earmuff"],"description":"Prevent the specified UUID from hearing audio"}}}
```

| action | verbatim description |
|---|---|
| `mute` | "Mute the specified UUID" |
| `unmute` | "Unmute the specified UUID" |
| `earmuff` | "Prevent the specified UUID from hearing audio" |
| `unearmuff` | "Allow the specified UUID to hear audio" |

**Confirmed global per-leg switches.** No list, no counterparty argument, no target array. The scope is
the single leg in the URL path. Corroborated independently in `Vonage/vonage-node-sdk`,
`packages/voice/lib/types/Parameters/EarmuffCallParameters.ts`, whose entire type is
`{ action: 'earmuff' }`.

`canspeak` / `canhear` / `can_speak` / `can_hear` appear **0 times** in the whole 62 KB spec.

Full v1 surface is 11 endpoints; only `PUT /{uuid}` touches routing. `stream` and `talk` inject audio
but do not change who hears whom. Voice API **v2** (`2.2.2`, "Voice API BETA") has a single endpoint,
`POST /` — it cannot modify a live call at all.

## 3. Conversation API: a member-update endpoint exists, but it does NOT carry audio

Source: <https://developer.vonage.com/en/api/conversation>

`PATCH /v1/conversations/{conversation_id}/members/{member_id}` exists. Its complete request body is
`{state, from, reason}` — membership lifecycle only. Verified against the published schema and
four independently-written server SDKs, **none of which sends a `media` field on PATCH**:

`Vonage/vonage-node-sdk`, `packages/conversations/lib/types/parameters/updateMemberParameters.ts`:
```ts
export type UpdateMemberParameters = {
  state: MemberState.LEFT | MemberState.JOINED;
  from: string;
  reason?: { code: string; text: string; }
}
```

`media.audio_settings` is real and its fields are exactly `enabled`, `earmuffed`, `muted` — but all
three are **global per-member booleans**, and they appear on **create-member (POST)** and in member
responses, not on the update path.

`Vonage/vonage-node-sdk`, `packages/conversations/lib/types/audioSettings.ts`:
```ts
export type AudioSettings = { enabled: boolean; earmuffed: boolean; muted: boolean; };
```

Contrast, same repo, `packages/voice/lib/types/NCCO/ConversationAction.ts`:
```ts
  canSpeak?: string[];
  canHear?: string[];
```

**`string[]` in the Voice NCCO. `boolean` in the Conversation API.** The selective-routing primitive
exists in exactly one of the two APIs, and it is not the one with a live-mutation endpoint.

## 4. Client SDK for JavaScript — confirmed usable for browser legs

`serverCall(context?: Json): Promise<string>` returns the `callId`; the context is delivered to the
`answer_url` webhook as `custom_data`.
Sources: <https://developer.vonage.com/en/vonage-client-sdk/in-app-voice/guides/make-call>,
<https://vonage.github.io/client-sdk-api-docs/latest/ts/classes/VonageClient.html>,
<https://developer.vonage.com/en/voice/voice-api/webhook-reference>
(`custom_data`: "A custom data object, optionally passed as parameter on the `serverCall` method").

Browser bundle: `@vonage/client-sdk@2.7.0`, `dist/vonageClientSDK.js`.

## VERDICT ON THE THREE MECHANISMS

| | exists? | evidence |
|---|---|---|
| **A — direct mutation of canSpeak/canHear on a live leg** | **NO** | 0 occurrences in the Voice spec; the only member-update endpoint carries `{state, from, reason}`; every Conversation-API audio control is a global boolean |
| **B — transfer into a new conversation action** | **YES, documented** | `destination.ncco` is `"items": {"type": "object"}` — completely unconstrained, so an inline `conversation` action carrying fresh `canSpeak`/`canHear` is accepted |
| **C — earmuff/unearmuff** | **YES, but global only** | one-property schemas, "the specified UUID" |

Step 0 therefore does **not** kill the project. A does not exist, but **B is documented and
untested**, so the empirical question stands and the rig is warranted.

Relevant to B, from the NCCO `transfer` action:
> "The `transfer` action is terminal for the current conversation... **All legs** of the current
> conversation are transferred into the target conversation, respecting the audio settings
> (`canHear`, `canSpeak`, `mute`) if they're provided."

Two things to watch when B is finally run: it is architecturally a **re-join, not an in-place
mutation**, and that wording says *all legs*, which may not be the per-leg scope the design needs.
The docs are also internally inconsistent here — the parameter table says `conversation_id` while
the worked example on the same page writes `conversationId`.
