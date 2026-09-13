# Tech Cafe AI Helpdesk (POC)

Standalone realtime voice Help Desk POC: click one button, talk to an Azure OpenAI Realtime speech-to-speech model over WebRTC.

## What it does

1. Set your preferred mic/speaker in **Windows Sound** settings (the app uses system defaults only).
2. Open the local web page.
3. Click **Tech Cafe AI Helpdesk**.
4. Grant microphone access.
5. Establish a live two-way voice session with Azure OpenAI Realtime (`gpt-realtime-2.1` by default).
6. Speak naturally; the AI replies by voice.
7. Click **End Call** to hang up and release the microphone.

This is a technical POC, not a production portal integration.

## Architecture

```text
Browser (mic + speakers)
    |  SDP offer (POST /session)
    v
Flask (AZURE_OPENAI_API_KEY stays here)
    |  1) POST /openai/v1/realtime/client_secrets  (session + Help Desk prompt)
    |  2) POST /openai/v1/realtime/calls           (SDP with ephemeral token)
    v
Azure OpenAI Realtime
    ^
    |  WebRTC media (audio) directly with the browser
Browser
```

- Permanent Azure API key never reaches HTML/JS.
- Flask returns only the SDP answer.
- Help Desk behavior is loaded from `techcafe_prompt.txt` into the Realtime session instructions.
- Turn detection: `semantic_vad` with `create_response` + `interrupt_response` enabled (barge-in).

## Project structure

```text
app.py
requirements.txt
.env.example
.gitignore
README.md
techcafe_prompt.txt
project_memory.md
templates/index.html
static/style.css
static/app.js
MISC/                  # credential smoke tests
```

## Prerequisites

- Windows 10/11
- Python 3.10+ recommended
- Chrome or Edge (microphone + WebRTC). On this POC host, **Edge is confirmed working**. The app uses the **Windows default** input/output devices (no in-page device menu).
- Azure Foundry / Azure OpenAI resource with a **Realtime** deployment
- Network access from your PC to `*.openai.azure.com`

## Setup (PowerShell)

```powershell
cd "D:\Cursor\AI Tech Cafe"

python -m venv .venv
.\.venv\Scripts\Activate.ps1

pip install -r requirements.txt

Copy-Item .env.example .env
```

Edit `.env`:

```text
AZURE_OPENAI_API_KEY=...
AZURE_OPENAI_ENDPOINT=https://fr-techcafe.openai.azure.com/openai/v1
AZURE_OPENAI_REALTIME_DEPLOYMENT=gpt-realtime-2.1
AZURE_OPENAI_CHAT_DEPLOYMENT=gpt-5.5
AZURE_OPENAI_VOICE=cedar
AZURE_REASONING_EFFORT=high
AZURE_INTERRUPT_RESPONSE=true
AZURE_VAD_THRESHOLD=0.5
AZURE_VAD_PREFIX_MS=300
AZURE_VAD_SILENCE_MS=850
```

Optional deployments you already have: `gpt-realtime`, `gpt-realtime-2.1`, `gpt-realtime-mini`.

## Run

```powershell
.\.venv\Scripts\Activate.ps1
python app.py
```

Open locally: [https://127.0.0.1:5000](https://127.0.0.1:5000)  
LAN / any browser: `https://<this-host-ip>:5000` (HTTPS required for microphone; accept the self-signed certificate warning). Desktop Edge/Chrome on the same PC can also use `https://127.0.0.1:5000`. Set `FLASK_SSL=false` only if you need plain HTTP on a trusted desktop.

Allow microphone permission when prompted.

## How the WebRTC / Realtime flow works

1. Browser creates `RTCPeerConnection`, attaches mic track, opens data channel `realtime-channel`.
2. Browser POSTs SDP offer to Flask `/session`.
3. Flask loads `techcafe_prompt.txt`, mints ephemeral client secret via Azure `client_secrets`.
4. Flask posts SDP to Azure `realtime/calls` using that ephemeral token.
5. Flask returns SDP answer; browser completes WebRTC.
6. On data-channel open, browser sends `response.create` so the AI greets first.
7. Ongoing turns use server-side semantic VAD; interruption is enabled.

## Prompt loading

`app.py` reads `techcafe_prompt.txt` on each `/session` request and sends it as Realtime `session.instructions`. Edit that file to change Help Desk behavior without changing code.

## Security

- Keep `.env` out of git (already in `.gitignore`).
- Never put the Azure key in frontend code.
- Rotate keys if they were shared in chat or screenshots.
- This POC has no employee login or authorization controls.

## Troubleshooting

| Symptom | What to check |
|---|---|
| `AZURE_OPENAI_API_KEY is not configured` | Create `.env` from `.env.example` |
| Unable to connect / 401 | Key invalid or wrong resource |
| Realtime operation not supported | Deploy a Realtime model; set `AZURE_OPENAI_REALTIME_DEPLOYMENT` to the **deployment name** |
| Microphone message | Allow mic for `http://127.0.0.1:5000` in browser site settings |
| No AI audio | Check browser console WebRTC state; unmute tab; confirm speakers |
| Credential smoke test | `.\MISC\Test-AzureOpenAI.ps1` |

## Known POC limitations

- ServiceNow ticket creation is **simulated**
- Tech Cafe booking is **simulated**
- No employee authentication
- No conversation persistence / database
- Restarting the app drops transient state
- Not hardened for production multi-user load

## Future architecture

```text
Tech Cafe Portal
       |
Talk to Tech Cafe AI
       |
Realtime AI Agent
       |
 +-----+------+
 |     |      |
 v     v      v
Remote Tech Cafe  ServiceNow
```

Later tools could book real Tech Cafe slots or create real incidents. Not implemented here.

## Dual-model behavior

- **Voice / conversation:** Azure Realtime `gpt-realtime-2.1`
- **Deep diagnostics:** Azure chat `gpt-5.5` via tool `consult_helpdesk_expert`
- Flow: Realtime may call the tool → browser POSTs `/api/diagnose` → GPT-5.5 result returned to Realtime → Realtime speaks the next step

Status text **Consulting GPT-5.5...** appears when the expert model is used.

## Call quality tips

If AI speech sounds choppy/interrupted:
- Use **Edge** (confirmed working on this host)
- Prefer a **wired headset** when possible — **Bluetooth** (e.g. Shokz) often causes intermittent playout
- Prefer wired network / disable flaky VPN if possible
- Default enables **barge-in** (`AZURE_INTERRUPT_RESPONSE=true`): on user speech the client cancels the AI response and clears buffered audio. Mic track is not muted mid-call (Bluetooth-safe).
- VAD defaults favor natural phone turn-taking (`silence_duration_ms=850`) while still responding promptly after the caller finishes.

To re-enable barge-in (talk-over-AI), set in `.env`:

```text
AZURE_INTERRUPT_RESPONSE=true
```


1. Outlook mail issue → name first, then remote troubleshooting  
2. Teams desktop broken, web OK → Tech Cafe recommendation  
3. AD account locked → simulated ServiceNow  
4. Cantonese caller → Cantonese replies  
5. Speak while AI talks → barge-in / interrupt  

Live voice quality requires your Azure key and a browser mic test.
