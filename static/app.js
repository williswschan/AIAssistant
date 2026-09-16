(() => {
  const startBtn = document.getElementById("startBtn");
  const endBtn = document.getElementById("endBtn");
  const statusEl = document.getElementById("status");
  const timerEl = document.getElementById("timer");
  const meterWrap = document.getElementById("meterWrap");
  const meterBar = document.getElementById("meterBar");
  const debugEl = document.getElementById("debug");
  const micSelect = document.getElementById("micSelect");
  const speakerSelect = document.getElementById("speakerSelect");
  const devicePickers = document.getElementById("devicePickers");
  const MIC_STORAGE_KEY = "tc_mic_device";
  const SPEAKER_STORAGE_KEY = "tc_speaker_device";
  const supportsSpeakerSelect =
    typeof HTMLMediaElement !== "undefined" &&
    typeof HTMLMediaElement.prototype.setSinkId === "function";

  let peerConnection = null;
  let dataChannel = null;
  let localStream = null;
  let remoteAudio = null;
  let audioSender = null;
  let callTimerId = null;
  let statsTimerId = null;
  let callStartedAt = null;
  let isEnding = false;
  let greetingSent = false;
  let greetingResponseId = null;
  let greetingReadyTimerId = null;
  let greetingGraceTimerId = null;
  let greetingAudioStarted = false;
  let greetingMicHeld = false;
  // response.done = generation finished, NOT playback finished (esp. Bluetooth).
  // Only unlock after output_audio_buffer.stopped + short grace.
  const GREETING_BARGEIN_FALLBACK_MS = 15000;
  const GREETING_BARGEIN_GRACE_MS = 700;
  let meterContext = null;
  let meterAnimId = null;
  let lastMicPct = 0;
  let lastBytesSent = 0;
  let zeroUplinkSeconds = 0;
  let micRecovering = false;
  let micOpChain = Promise.resolve();
  let micOpSeq = 0;
  let httpOpChain = Promise.resolve();
  let consultHttpBusy = false;
  let controlWs = null;
  let controlWsReady = null;
  let controlWsPingTimerId = null;
  let controlWsReconnectTimerId = null;
  let controlWsIgnoreClose = false;
  const pendingWsRequests = new Map();
  let isConnecting = false;
  let pendingHangup = false;
  let hangupTimerId = null;
  let hangupGraceTimerId = null;
  let hangupAudioHeard = false;
  let hangupGoodbyeRequested = false;
  let hangupAwaitingSpeechCheck = false;
  let lastAssistantAudioStoppedAt = null;
  let lastAssistantTranscript = "";
  const HANGUP_RECENT_GOODBYE_MS = 4000;
  const FAREWELL_SPEECH_RE =
    /\bgoodbye\b|\bbye[- ]?bye\b|\bbye\b|再見|再见|拜拜|さようなら|失礼いたします|失礼します|have a (good|great) day/i;
  const CLOSING_FAREWELL_RE =
    /thank(?:s| you)? for calling|thanks for calling tech cafe|take care|have a (?:good|great) day|tech cafe it help desk/i;
  let aiSpeaking = false;
  let assistantResponseActive = false;
  let currentAssistantItemId = null;
  let assistantPlayStartedAt = null;
  let bargeInInProgress = false;
  let userTurnActive = false;
  let activeResponseId = null;
  // Realtime sometimes emits a short stall reply then a second full reply with no
  // user speech in between (call-20260912-205224-3fa7). Cap to one per user turn.
  let assistantRepliesThisUserTurn = 0;
  const cancelledResponseIds = new Set();
  let selectedVoice = "marin";
  let diagnoseHoldTimerId = null;
  let diagnoseHoldInFlight = false;
  let diagnoseHoldLanguage = "English";
  let diagnoseHoldUseRealtime = true;
  let holdOutboundPending = 0;
  let diagnoseLastOutput = null;
  let diagnoseDeliveringResult = false;
  let diagnoseSpeakRequested = false;
  let diagnoseSpeakArmed = false;
  let diagnoseOwnResponseId = null;
  let diagnoseSpeakSentAt = 0;
  let diagnoseSpeakRetryTimerId = null;
  let bookingOfferStage = null; // null | "techcafe_pitch" | "slot_offer" | "booked"
  let bookingAdvancePending = false;
  let bookingAdvanceArmed = false;
  let bookingAdvanceOwnResponseId = null;
  let bookingAdvanceTimerId = null;
  let connectingToneAudio = null;
  let connectingToneTimerId = null;
  let connectingToneActive = false;
  let connectingToneUrl = null;
  let connectingToneGain = null;
  let connectingToneOscillators = [];
  let callAudioReady = false;
  let outputAudioContext = null;
  let remoteStreamAudioSource = null;
  let attachedRemoteStream = null;
  let remotePlaybackMode = "element";
  // Resolved after mic open so ring + AI voice share the OS-selected output
  // (not just Chrome's multimedia "default", which can stay on built-in speakers
  // while Bluetooth HFP is the communications / mic-matched device).
  let preferredOutputSinkId = "default";
  // North American PSTN ringback (what you hear while a call is ringing):
  // 440 Hz + 480 Hz for 2s, then 4s silence. ITU-T / NANP standard.
  const CONNECTING_RING_ON_SEC = 2.0;
  const CONNECTING_RING_CYCLE_MS = 6000;
  const DIAGNOSE_HOLD_MS = 5000;
  // Kill Azure auto-replies after function_call_output before we speak.
  const DIAGNOSE_AUTO_KILL_MS = 1200;
  let transcriptLoggingEnabled = false;
  let transcriptId = null;
  let sessionCallId = null;
  let pendingTicketFields = null;
  let ticketDraft = {
    caller_name: "",
    problem_summary: "",
    solution_summary: "",
    resolved: null,
  };
  // Letter-by-letter spelling heard in assistant speech (authoritative over mishears).
  let spelledCallerName = "";
  let transcriptionDeployment = null;
  let turnDetectionConfig = {
    type: "server_vad",
    threshold: 0.5,
    prefix_padding_ms: 300,
    silence_duration_ms: 900,
    create_response: true,
    interrupt_response: true,
  };
  let realtimeTruncationRetentionRatio = 0.8;
  const recentEvents = [];
  const handledCallIds = new Set();

  setStatus("Ready — tap the button to start (uses mic + speakers)");

  if (!supportsSpeakerSelect && speakerSelect) {
    const speakerField = speakerSelect.closest(".device-field");
    if (speakerField) {
      speakerField.classList.add("hidden");
    }
  }

  refreshDeviceLists().catch((error) => {
    console.warn("[WARN] Initial device list failed", error);
  });

  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener("devicechange", () => {
      refreshDeviceLists().catch(() => {});
    });
  }

  if (micSelect) {
    micSelect.addEventListener("change", () => {
      persistDeviceChoice(MIC_STORAGE_KEY, micSelect.value || "default");
      console.log("[INFO] Mic selection:", micSelect.value || "default");
    });
    micSelect.addEventListener("focus", () => {
      ensureDeviceLabels().catch(() => {});
    });
  }
  if (speakerSelect) {
    speakerSelect.addEventListener("change", () => {
      persistDeviceChoice(SPEAKER_STORAGE_KEY, speakerSelect.value || "default");
      console.log("[INFO] Speaker selection:", speakerSelect.value || "default");
      // Preview sink on idle remote/unlock element when possible.
      setElementOutputSink(remoteAudio).catch(() => {});
    });
    speakerSelect.addEventListener("focus", () => {
      ensureDeviceLabels().catch(() => {});
    });
  }

  if (!window.isSecureContext) {
    setStatus(
      "This browser needs HTTPS for the microphone. Open https://" +
        location.hostname +
        (location.port ? ":" + location.port : "") +
        " and accept the certificate warning."
    );
  } else if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus("Microphone API unavailable in this browser.");
  }

  startBtn.addEventListener("click", () => {
    if (isConnecting) {
      return;
    }
    if (!window.isSecureContext) {
      setStatus(
        "Use HTTPS for mic access in the browser (https://" +
          location.hostname +
          (location.port ? ":" + location.port : "") +
          ")."
      );
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus("Microphone API unavailable in this browser.");
      return;
    }
    // Chrome/Edge: unlock AudioContext on click. After mic opens we rebind
    // playback to OS default sink so ringtone and AI voice share one output.
    unlockOutputAudioFromUserGesture();
    enqueueMicOp(() => startCall()).catch((error) => {
      console.error("[ERROR] startCall failed", error);
      isConnecting = false;
      stopConnectingTone();
      if (error && error.name === "NotAllowedError") {
        setStatus("Microphone access is required to talk to Tech Cafe AI.");
      } else {
        setStatus((error && error.message) || "Connection failed");
      }
      cleanupCall(false);
    });
  });

  endBtn.addEventListener("click", () => {
    endCall();
  });

  window.addEventListener("beforeunload", () => {
    cleanupCall(false);
  });

  function enqueueMicOp(fn) {
    const run = micOpChain.then(() => fn());
    micOpChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  function enqueueHttp(fn) {
    // Serialize phone→Flask HTTP so transcript appends do not collide with
    // expert-start POSTs (iOS was resetting concurrent SSL requests).
    const run = httpOpChain.then(() => fn());
    httpOpChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  function delay(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timerId = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      window.clearTimeout(timerId);
    }
  }

  function toBase64UrlJson(value) {
    const json = JSON.stringify(value);
    const bytes = new TextEncoder().encode(json);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 1) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function pingClientLog(eventName, detail) {
    try {
      const url = new URL("/api/client-log", window.location.origin);
      url.searchParams.set("event", eventName || "ping");
      if (detail) {
        url.searchParams.set("detail", String(detail).slice(0, 240));
      }
      // Fire-and-forget GET — same path class that already works on iPhone.
      fetch(url.toString(), { method: "GET", cache: "no-store" }).catch(() => {});
    } catch (_error) {
      // ignore
    }
  }

  function closeControlSocket() {
    if (controlWsPingTimerId) {
      window.clearInterval(controlWsPingTimerId);
      controlWsPingTimerId = null;
    }
    if (controlWsReconnectTimerId) {
      window.clearTimeout(controlWsReconnectTimerId);
      controlWsReconnectTimerId = null;
    }
    if (controlWs) {
      controlWsIgnoreClose = true;
      try {
        controlWs.close();
      } catch (_error) {
        // ignore
      }
    }
    controlWs = null;
    controlWsReady = null;
    pendingWsRequests.forEach((pending) => {
      try {
        pending.reject(new Error("WebSocket closed"));
      } catch (_error) {
        // ignore
      }
    });
    pendingWsRequests.clear();
  }

  function startControlWsPing() {
    if (controlWsPingTimerId) {
      window.clearInterval(controlWsPingTimerId);
    }
    // Keepalive so reverse proxies do not idle-close WSS mid-call
    // ("Invalid frame header" often follows a proxy timeout).
    controlWsPingTimerId = window.setInterval(() => {
      if (!controlWs || controlWs.readyState !== WebSocket.OPEN) {
        return;
      }
      try {
        controlWs.send(
          JSON.stringify({ type: "ping", id: "ping-" + Date.now() })
        );
      } catch (_error) {
        // ignore
      }
    }, 8000);
  }

  function scheduleControlWsReconnect() {
    if (isEnding || isConnecting || !peerConnection) {
      return;
    }
    if (controlWsReconnectTimerId) {
      return;
    }
    controlWsReconnectTimerId = window.setTimeout(() => {
      controlWsReconnectTimerId = null;
      if (isEnding || !peerConnection) {
        return;
      }
      console.log("[INFO] Reconnecting control WebSocket...");
      pushDebug("ws:reconnect");
      openControlSocket().catch((error) => {
        console.warn("[WARN] Control WebSocket reconnect failed", error);
      });
    }, 1200);
  }

  function openControlSocket() {
    closeControlSocket();
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = protocol + "//" + window.location.host + "/ws/control";
    const ws = new WebSocket(wsUrl);
    controlWs = ws;
    controlWsReady = new Promise((resolve, reject) => {
      const timerId = window.setTimeout(() => {
        reject(new Error("Control WebSocket timeout"));
      }, 8000);
      ws.addEventListener("open", () => {
        window.clearTimeout(timerId);
        console.log("[INFO] Control WebSocket open");
        pushDebug("ws:open");
        pingClientLog("ws_open_client");
        startControlWsPing();
        resolve();
      });
      ws.addEventListener("error", () => {
        window.clearTimeout(timerId);
        console.warn("[WARN] Control WebSocket error");
        pushDebug("ws:error");
        reject(new Error("Control WebSocket error"));
      });
    });
    ws.addEventListener("message", (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch (_error) {
        return;
      }
      if (data && data.type === "pong") {
        return;
      }
      const reqId = data && data.id;
      if (!reqId || !pendingWsRequests.has(reqId)) {
        return;
      }
      const pending = pendingWsRequests.get(reqId);
      pendingWsRequests.delete(reqId);
      pending.resolve(data);
    });
    ws.addEventListener("close", () => {
      console.log("[INFO] Control WebSocket closed");
      pushDebug("ws:close");
      if (controlWsPingTimerId) {
        window.clearInterval(controlWsPingTimerId);
        controlWsPingTimerId = null;
      }
      if (controlWs === ws) {
        controlWs = null;
        controlWsReady = null;
      }
      if (controlWsIgnoreClose) {
        controlWsIgnoreClose = false;
        return;
      }
      scheduleControlWsReconnect();
    });
    return controlWsReady;
  }

  function wsRequest(type, payload, timeoutMs) {
    const requestId = "ws" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    return new Promise((resolve, reject) => {
      const timerId = window.setTimeout(() => {
        pendingWsRequests.delete(requestId);
        reject(new Error("WebSocket request timeout"));
      }, timeoutMs || 12000);
      pendingWsRequests.set(requestId, {
        resolve: (data) => {
          window.clearTimeout(timerId);
          resolve(data);
        },
        reject: (error) => {
          window.clearTimeout(timerId);
          reject(error);
        },
      });
      Promise.resolve(controlWsReady)
        .then(() => {
          if (!controlWs || controlWs.readyState !== WebSocket.OPEN) {
            throw new Error("Control WebSocket not open");
          }
          controlWs.send(
            JSON.stringify({
              id: requestId,
              type: type,
              ...(payload || {}),
            })
          );
        })
        .catch((error) => {
          pendingWsRequests.delete(requestId);
          window.clearTimeout(timerId);
          reject(error);
        });
    });
  }

  function persistDeviceChoice(key, value) {
    try {
      window.localStorage.setItem(key, value || "default");
    } catch (_error) {
      // ignore
    }
  }

  function readDeviceChoice(key) {
    try {
      return window.localStorage.getItem(key) || "default";
    } catch (_error) {
      return "default";
    }
  }

  function setDevicePickersEnabled(enabled) {
    if (micSelect) {
      micSelect.disabled = !enabled;
    }
    if (speakerSelect) {
      speakerSelect.disabled = !enabled;
    }
  }

  function fillSelectOptions(selectEl, devices, selectedId) {
    if (!selectEl) {
      return;
    }
    const previous = selectedId || selectEl.value || "default";
    selectEl.innerHTML = "";
    const defaultOpt = document.createElement("option");
    defaultOpt.value = "default";
    defaultOpt.textContent = "System default";
    selectEl.appendChild(defaultOpt);
    devices.forEach((device, index) => {
      if (!device.deviceId || device.deviceId === "default") {
        return;
      }
      // Skip Windows role aliases; "System default" maps to OS current selection.
      if (device.deviceId === "communications") {
        return;
      }
      const opt = document.createElement("option");
      opt.value = device.deviceId;
      opt.textContent =
        device.label ||
        (device.kind === "audioinput"
          ? "Microphone " + (index + 1)
          : "Speaker " + (index + 1));
      selectEl.appendChild(opt);
    });
    const hasPrevious = Array.from(selectEl.options).some(
      (opt) => opt.value === previous
    );
    selectEl.value = hasPrevious ? previous : "default";
  }

  async function refreshDeviceLists() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      return;
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((device) => device.kind === "audioinput");
    const outputs = devices.filter((device) => device.kind === "audiooutput");
    fillSelectOptions(micSelect, inputs, readDeviceChoice(MIC_STORAGE_KEY));
    if (supportsSpeakerSelect) {
      fillSelectOptions(
        speakerSelect,
        outputs,
        readDeviceChoice(SPEAKER_STORAGE_KEY)
      );
    }
  }

  async function ensureDeviceLabels() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return;
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    const needsPermission = devices.some(
      (device) =>
        (device.kind === "audioinput" || device.kind === "audiooutput") &&
        !device.label
    );
    if (!needsPermission) {
      await refreshDeviceLists();
      return;
    }
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      console.warn("[WARN] Device label permission failed", error);
      return;
    } finally {
      if (stream) {
        stream.getTracks().forEach((track) => {
          try {
            track.stop();
          } catch (_error) {
            // ignore
          }
        });
      }
    }
    await refreshDeviceLists();
  }

  function getSelectedMicDeviceId() {
    const value = micSelect ? micSelect.value : "default";
    return value && value !== "default" ? value : null;
  }

  function getSelectedSpeakerDeviceId() {
    if (!supportsSpeakerSelect || !speakerSelect) {
      return null;
    }
    const value = speakerSelect.value;
    return value && value !== "default" ? value : "default";
  }

  function buildDefaultAudioConstraints(preferredRole) {
    const audio = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    };
    try {
      // Chrome aliases — help reduce headset loudspeaker→mic feedback.
      audio.echoCancellation = { ideal: true };
      audio.noiseSuppression = { ideal: true };
      audio.autoGainControl = { ideal: true };
    } catch (_error) {
      // ignore
    }
    try {
      audio.voiceIsolation = true;
    } catch (_error) {
      // ignore unsupported constraint
    }
    // Chrome/Edge desktop: avoid constraints that can monopolize the device
    // in ways that leave playback silent while Safari still works.
    if (!/iphone|ipad|ipod|android/i.test(navigator.userAgent || "")) {
      delete audio.voiceIsolation;
    }
    const micDeviceId = getSelectedMicDeviceId();
    if (micDeviceId) {
      audio.deviceId = { exact: micDeviceId };
    } else if (preferredRole === "communications") {
      // Windows: follow Default Communications Device (often the headset
      // currently selected for calls), not only the multimedia Default Device.
      audio.deviceId = { ideal: "communications" };
    }
    return { audio };
  }

  async function requestUserMedia(constraints, timeoutMs) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error(
        "Microphone requires a secure page (HTTPS). Open the https:// URL on this phone."
      );
    }
    const controller =
      typeof AbortController !== "undefined" ? new AbortController() : null;
    let timerId = null;
    const mediaOpts = { ...constraints };
    if (controller) {
      mediaOpts.signal = controller.signal;
    }

    const mediaPromise = navigator.mediaDevices.getUserMedia(mediaOpts).catch((error) => {
      if (controller && mediaOpts.signal) {
        return navigator.mediaDevices.getUserMedia({ ...constraints });
      }
      throw error;
    });

    try {
      const timeoutPromise = new Promise((_, reject) => {
        timerId = window.setTimeout(() => {
          if (controller) {
            try {
              controller.abort();
            } catch (_error) {
              // ignore
            }
          }
          reject(new Error("Microphone open timed out"));
        }, timeoutMs);
      });
      return await Promise.race([mediaPromise, timeoutPromise]);
    } catch (error) {
      mediaPromise
        .then((stream) => {
          stream.getTracks().forEach((track) => track.stop());
        })
        .catch(() => {});
      throw error;
    } finally {
      if (timerId) {
        window.clearTimeout(timerId);
      }
    }
  }

  async function acquireDefaultMicrophone() {
    const seq = ++micOpSeq;
    stopMicMeter();

    const previous = localStream;
    localStream = null;
    if (previous) {
      previous.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch (_error) {
          // ignore
        }
      });
      await delay(200);
    }

    if (seq !== micOpSeq) {
      throw new Error("Microphone open cancelled");
    }

    console.log(
      "[INFO] Opening microphone:",
      getSelectedMicDeviceId() || "system default (OS current)"
    );
    let stream;
    try {
      stream = await requestUserMedia(
        buildDefaultAudioConstraints(
          getSelectedMicDeviceId() ? null : "communications"
        ),
        8000
      );
    } catch (firstError) {
      // communications role unsupported or busy — fall back to OS default mic.
      if (!getSelectedMicDeviceId()) {
        console.warn(
          "[WARN] Communications mic unavailable; using OS default mic",
          firstError
        );
        stream = await requestUserMedia(buildDefaultAudioConstraints(null), 8000);
      } else {
        throw firstError;
      }
    }
    if (seq !== micOpSeq) {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error("Microphone open cancelled");
    }
    return stream;
  }

  async function openMicrophoneForCall() {
    const stream = await acquireDefaultMicrophone();
    localStream = stream;
    const track = localStream.getAudioTracks()[0];
    if (!track) {
      throw new Error("No microphone track available.");
    }
    track.enabled = true;
    console.log(
      "[INFO] Active mic:",
      track.label || "(system default)",
      "muted=",
      track.muted,
      "readyState=",
      track.readyState
    );
    refreshDeviceLists().catch(() => {});
    startMicMeter(localStream);
    meterWrap.classList.remove("hidden");
    meterWrap.setAttribute("aria-hidden", "false");
    // Keep uplink silent until greeting finishes — Azure still clears Hello
    // on speech even with interrupt_response false.
    holdGreetingMic();
  }

  function releaseMicrophone() {
    stopMicMeter();
    stopOutboundStats();
    if (localStream) {
      localStream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch (_error) {
          // ignore
        }
      });
      localStream = null;
    }
    meterWrap.classList.add("hidden");
    meterWrap.setAttribute("aria-hidden", "true");
  }

  async function startCall() {
    isEnding = false;
    isConnecting = true;
    greetingSent = false;
    greetingResponseId = null;
    greetingAudioStarted = false;
    greetingMicHeld = false;
    clearGreetingReadyTimer();
    clearGreetingGraceTimer();
    callAudioReady = false;
    pendingHangup = false;
    if (hangupTimerId) {
      window.clearTimeout(hangupTimerId);
      hangupTimerId = null;
    }
    handledCallIds.clear();
    lastBytesSent = 0;
    zeroUplinkSeconds = 0;
    micRecovering = false;
    hangupAudioHeard = false;
    hangupGoodbyeRequested = false;
    hangupAwaitingSpeechCheck = false;
    lastAssistantAudioStoppedAt = null;
    lastAssistantTranscript = "";
    aiSpeaking = false;
    assistantResponseActive = false;
    currentAssistantItemId = null;
    assistantPlayStartedAt = null;
    bargeInInProgress = false;
    userTurnActive = false;
    assistantRepliesThisUserTurn = 0;
    activeResponseId = null;
    cancelledResponseIds.clear();
    bookingOfferStage = null;
    clearBookingAdvanceState();
    if (hangupGraceTimerId) {
      window.clearTimeout(hangupGraceTimerId);
      hangupGraceTimerId = null;
    }
    recentEvents.length = 0;
    setStatus("Connecting...");
    startBtn.disabled = true;
    setDevicePickersEnabled(false);

    await openMicrophoneForCall();

    let micTrack = localStream.getAudioTracks()[0];
    if (!micTrack || micTrack.readyState !== "live") {
      throw new Error("System microphone is not active. Check Windows Sound settings.");
    }
    micTrack.enabled = true;
    wireMicTrackEvents(micTrack);

    // After mic capture, Windows Bluetooth often switches to Headset (HFP).
    // Wait for that profile flip, then bind ringtone + AI playback to the same
    // OS-selected output (mic group / communications / default).
    await delay(450);
    await applyOutputDeviceRouting();
    startConnectingTone();

    if (lastMicPct < 1) {
      const micName = String(micTrack.label || "").toLowerCase();
      if (/bluetooth|shokz|opencomm|headset|hands-?free/i.test(micName)) {
        console.log(
          "[INFO] Mic meter ~0% at start (common on Bluetooth headsets like Shokz)."
        );
      } else {
        console.warn(
          "[WARN] Mic level is still ~0%. Speak briefly or check Windows Sound > Input."
        );
      }
    }

    const tokenResponse = await fetch("/token");
    if (!tokenResponse.ok) {
      let message = "Unable to connect to the Tech Cafe AI service.";
      try {
        const payload = await tokenResponse.json();
        if (payload && payload.error) {
          message = payload.error;
        }
      } catch (_error) {
        // keep default
      }
      throw new Error(message);
    }
    const tokenData = await tokenResponse.json();
    const ephemeralKey = tokenData.token;
    const webrtcUrl = tokenData.webrtc_url;
    if (tokenData.voice) {
      selectedVoice = String(tokenData.voice).trim().toLowerCase();
      console.log("[INFO] Session voice:", selectedVoice);
      pushDebug("voice:" + selectedVoice);
    }
    if (tokenData.turn_detection) {
      turnDetectionConfig = {
        type: tokenData.turn_detection.type || "server_vad",
        threshold:
          typeof tokenData.turn_detection.threshold === "number"
            ? tokenData.turn_detection.threshold
            : 0.5,
        prefix_padding_ms:
          typeof tokenData.turn_detection.prefix_padding_ms === "number"
            ? tokenData.turn_detection.prefix_padding_ms
            : 300,
        silence_duration_ms:
          typeof tokenData.turn_detection.silence_duration_ms === "number"
            ? tokenData.turn_detection.silence_duration_ms
            : 1100,
        create_response: tokenData.turn_detection.create_response !== false,
        interrupt_response: tokenData.turn_detection.interrupt_response !== false,
      };
    }
    if (typeof tokenData.realtime_truncation_retention_ratio === "number") {
      realtimeTruncationRetentionRatio = tokenData.realtime_truncation_retention_ratio;
    }
    // Prefer server-created transcript id from /token (reliable even if a
    // separate start request never fires on some mobile browsers).
    transcriptId = tokenData.transcript_id ? String(tokenData.transcript_id) : null;
    sessionCallId = tokenData.call_id
      ? String(tokenData.call_id)
      : transcriptId;
    pendingTicketFields = null;
    ticketDraft = {
      caller_name: "",
      problem_summary: "",
      solution_summary: "",
      resolved: null,
    };
    spelledCallerName = "";
    transcriptLoggingEnabled = !!transcriptId;
    transcriptionDeployment = tokenData.transcription_deployment
      ? String(tokenData.transcription_deployment)
      : null;
    if (transcriptId) {
      console.log("[INFO] Transcript logging to", transcriptId);
      pushDebug("transcript:" + transcriptId);
    } else if (
      tokenData.transcript_logging === true ||
      tokenData.transcript_logging === "true" ||
      tokenData.transcript_logging === 1
    ) {
      // Fallback for older server builds that only expose the flag.
      await startTranscriptSession(true);
    } else {
      console.log("[INFO] Transcript logging off");
      pushDebug("transcript:off");
    }
    if (!ephemeralKey || !webrtcUrl) {
      throw new Error("Invalid token response from server.");
    }

    try {
      await openControlSocket();
    } catch (error) {
      console.warn("[WARN] Control WebSocket failed to open", error);
      pushDebug("ws:open_fail");
      pingClientLog("ws_open_fail", (error && error.message) || "open failed");
      // Continue — HTTP fallbacks still exist for consult.
    }

    peerConnection = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        { urls: "stun:stun.cloudflare.com:3478" },
      ],
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require",
    });

    // Uses the OS-selected playback device resolved after mic open.
    if (!remoteAudio) {
      remoteAudio = document.createElement("audio");
      remoteAudio.autoplay = true;
      remoteAudio.preload = "auto";
      remoteAudio.setAttribute("playsinline", "true");
      document.body.appendChild(remoteAudio);
    }
    remoteAudio.muted = false;
    remoteAudio.volume = 1.0;
    setElementOutputSink(remoteAudio).catch(() => {});

    peerConnection.ontrack = async (event) => {
      console.log("[INFO] Remote track received", event.track.kind);
      pushDebug("remote_track:" + event.track.kind);
      if (event.track && event.track.kind !== "audio") {
        return;
      }
      const stream = event.streams[0] || new MediaStream([event.track]);
      attachRemoteAudioStream(stream);
      window.setTimeout(() => {
        // During greeting mic-hold the meter is ~0% on purpose — do not treat
        // that as a dead mic or we thrash getUserMedia and stall WebRTC/Hello.
        if (greetingMicHeld || !callAudioReady) {
          ensureLiveMicOnSender("after_remote_audio_greeting").catch((error) => {
            console.warn("[WARN] mic ensure after remote audio failed", error);
          });
          return;
        }
        const track = localStream && localStream.getAudioTracks()[0];
        if (!track || track.readyState !== "live" || lastMicPct < 2) {
          recoverMicrophone("after_remote_audio").catch((error) => {
            console.warn("[WARN] mic recover after remote audio failed", error);
          });
        } else {
          ensureLiveMicOnSender("after_remote_audio").catch((error) => {
            console.warn("[WARN] mic ensure after remote audio failed", error);
          });
        }
      }, 1200);
    };

    peerConnection.onconnectionstatechange = () => {
      console.log("[INFO] connectionState:", peerConnection.connectionState);
      pushDebug("pc:" + peerConnection.connectionState);
      if (peerConnection.connectionState === "failed") {
        setStatus("Unable to establish the voice session.");
        cleanupCall(false);
      }
    };

    peerConnection.oniceconnectionstatechange = () => {
      console.log("[INFO] iceConnectionState:", peerConnection.iceConnectionState);
      pushDebug("ice:" + peerConnection.iceConnectionState);
    };

    audioSender = peerConnection.addTrack(micTrack, localStream);
    // Chrome can omit recv audio unless sendrecv is explicit.
    try {
      peerConnection.getTransceivers().forEach((transceiver) => {
        if (transceiver.sender && transceiver.sender.track === micTrack) {
          transceiver.direction = "sendrecv";
        }
      });
    } catch (_error) {
      // ignore
    }

    dataChannel = peerConnection.createDataChannel("oai-events");
    wireDataChannel(dataChannel);
    peerConnection.ondatachannel = (event) => wireDataChannel(event.channel);

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    await waitForIceGatheringComplete(peerConnection);
    const localSdp = peerConnection.localDescription.sdp;

    const sdpResponse = await fetch(webrtcUrl, {
      method: "POST",
      body: localSdp,
      headers: {
        Authorization: `Bearer ${ephemeralKey}`,
        "Content-Type": "application/sdp",
      },
    });

    if (!sdpResponse.ok) {
      const errText = await sdpResponse.text();
      console.error("[ERROR] Azure SDP failed", sdpResponse.status, errText);
      throw new Error("Unable to establish the voice session.");
    }

    const answerSdp = await sdpResponse.text();
    await peerConnection.setRemoteDescription({
      type: "answer",
      sdp: answerSdp,
    });

    await ensureLiveMicOnSender("post_sdp");

    startBtn.classList.add("hidden");
    if (devicePickers) {
      devicePickers.classList.add("hidden");
    }
    endBtn.classList.remove("hidden");
    timerEl.classList.remove("hidden");
    meterWrap.classList.remove("hidden");
    debugEl.classList.remove("hidden");
    startTimer();
    startOutboundStats();
    isConnecting = false;
    // Keep ringing through session setup until greeting audio starts
    // (avoids dead air between "Connected" and Hello).
    applyOutputDeviceRouting().catch(() => {});
    enableLocalPlayback();
    setStatus("Connected — ringing...");
  }

  function wireDataChannel(channel) {
    dataChannel = channel;
    channel.addEventListener("open", onDataChannelOpen);
    channel.addEventListener("message", onDataChannelMessage);
    channel.addEventListener("close", () => pushDebug("dc:close"));
    channel.addEventListener("error", () => pushDebug("dc:error"));
  }

  function buildPinnedVoiceResponse(extra) {
    // Pin session voice on every client-triggered reply. Mid-call timbre drift
    // is a known Realtime issue; repeating audio.output.voice helps keep marin.
    const response = {
      output_modalities: ["audio"],
      audio: {
        output: {
          voice: selectedVoice || "marin",
        },
      },
    };
    if (extra && typeof extra === "object") {
      Object.keys(extra).forEach((key) => {
        response[key] = extra[key];
      });
    }
    return response;
  }

  function sendAudioResponse(extra) {
    if (!dataChannel || dataChannel.readyState !== "open") {
      return false;
    }
    dataChannel.send(
      JSON.stringify({
        type: "response.create",
        response: buildPinnedVoiceResponse(extra),
      })
    );
    return true;
  }

  function reportedResponseVoice(payload) {
    const response = payload && payload.response;
    if (!response) {
      return null;
    }
    if (response.audio && response.audio.output && response.audio.output.voice) {
      return String(response.audio.output.voice).toLowerCase();
    }
    if (response.voice) {
      return String(response.voice).toLowerCase();
    }
    return null;
  }

  function onDataChannelOpen() {
    console.log("[INFO] Data channel open");
    pushDebug("dc:open");

    try {
      const truncationConfig =
        realtimeTruncationRetentionRatio >= 0.999
          ? "auto"
          : {
              type: "retention_ratio",
              retention_ratio: realtimeTruncationRetentionRatio,
            };
      dataChannel.send(
        JSON.stringify({
          type: "session.update",
          session: {
            type: "realtime",
            // Keep tools/instructions stable; do not rewrite instructions here
            // (stable prefix helps automatic Realtime prompt-cache hits).
            truncation: truncationConfig,
            tools: [
              {
                type: "function",
                name: "consult_helpdesk_expert",
                description:
                  "Consult gpt-6-astra for IT Help Desk triage after gathering caller name and issue details.",
                parameters: {
                  type: "object",
                  properties: {
                    caller_name: {
                      type: "string",
                      description:
                        "Confirmed caller name using the latest spelling/correction if known.",
                    },
                    issue_summary: { type: "string" },
                    symptoms: { type: "string" },
                    already_tried: { type: "string" },
                    caller_language: {
                      type: "string",
                      description:
                        "Language of the caller's latest spoken CONTENT (not their name). " +
                        "Names are often English/romanized and must be ignored for this field. " +
                        "Examples: English, Japanese, Chinese (Mandarin), Chinese (Cantonese).",
                    },
                  },
                  required: ["issue_summary"],
                },
              },
              {
                type: "function",
                name: "end_call",
                description:
                  "Hang up only after speaking a full polite goodbye that includes Goodbye, さようなら, 再见, or 再見. " +
                  "Never end silently. Always include call outcome fields for the ticket CSV: " +
                  "caller_name, problem_summary, solution_summary, resolved. " +
                  "resolved=false for ServiceNow / Tech Cafe escalation; true only if fixed on this call.",
                parameters: {
                  type: "object",
                  properties: {
                    reason: { type: "string" },
                    caller_name: {
                      type: "string",
                      description:
                        "Confirmed caller name (latest spelling/correction), or unknown. " +
                        "If they spelled letters (e.g. C-A-L-V-I-N), use that form (Calvin), not an earlier mishear (Kelvin).",
                    },
                    problem_summary: {
                      type: "string",
                      description: "Short summary of the reported IT problem.",
                    },
                    solution_summary: {
                      type: "string",
                      description:
                        "Fix applied, or alternative provided (ServiceNow / Tech Cafe session, etc).",
                    },
                    resolved: {
                      type: "boolean",
                      description:
                        "true only if solved on this call; false if escalated (ServiceNow / Tech Cafe).",
                    },
                  },
                  required: [
                    "reason",
                    "caller_name",
                    "problem_summary",
                    "solution_summary",
                    "resolved",
                  ],
                },
              },
            ],
            tool_choice: "auto",
            audio: {
              input: (() => {
                const input = {
                  // Disable server VAD entirely until greeting playback ends.
                  // interrupt_response:false alone still cleared Hello on speech.
                  turn_detection: null,
                };
                if (transcriptLoggingEnabled && transcriptionDeployment) {
                  input.transcription = { model: transcriptionDeployment };
                }
                return input;
              })(),
              output: {
                voice: selectedVoice,
              },
            },
          },
        })
      );
    } catch (error) {
      console.warn("[WARN] session.update failed", error);
    }

    window.setTimeout(sendGreeting, 800);
  }

  function pickOpeningGreeting() {
    // Fixed brand line + one of five similar help offers (random per call).
    const prefix = "Hello, Tech Cafe IT Help Desk.";
    const secondLines = [
      "How can I help you today?",
      "What can I help you with today?",
      "How may I assist you today?",
      "What brings you in today?",
      "How can I assist you?",
    ];
    let index = Math.floor(Math.random() * secondLines.length);
    try {
      const lastRaw = window.sessionStorage.getItem("tc_greeting_idx");
      const lastIdx = lastRaw == null ? -1 : parseInt(lastRaw, 10);
      if (
        secondLines.length > 1 &&
        !Number.isNaN(lastIdx) &&
        lastIdx === index
      ) {
        index = (index + 1) % secondLines.length;
      }
      window.sessionStorage.setItem("tc_greeting_idx", String(index));
    } catch (_error) {
      // sessionStorage may be unavailable
    }
    return prefix + " " + secondLines[index];
  }

  function sendGreeting() {
    if (!dataChannel || dataChannel.readyState !== "open" || greetingSent) {
      return;
    }
    greetingSent = true;
    greetingResponseId = null;
    greetingAudioStarted = false;
    clearGreetingReadyTimer();
    clearGreetingGraceTimer();
    // Do not stop ring here — cutover happens just before greeting audio
    // (output_item.added / output_audio_buffer.started) with a hard Web Audio mute.
    enableLocalPlayback();
    // Barge-in stays disabled until greeting audio finishes (see markCallAudioReady).
    const greetingLine = pickOpeningGreeting();
    console.log("[INFO] Opening greeting:", greetingLine);
    pushDebug("greeting:" + greetingLine.slice(28, 56));
    sendAudioResponse({
      tool_choice: "none",
      instructions:
        "This is the start of the call. Speak EXACTLY this opening greeting aloud and nothing else. " +
        "Do not add words, do not reorder, do not translate, and do not ask for the caller's name yet: " +
        JSON.stringify(greetingLine),
    });
    pushDebug("sent:response.create");
    setStatus("Connected — ringing...");
    // Safety: never leave barge-in locked if stop events are missed.
    greetingReadyTimerId = window.setTimeout(() => {
      markCallAudioReady("fallback_timeout");
    }, GREETING_BARGEIN_FALLBACK_MS);
  }

  function clearGreetingReadyTimer() {
    if (greetingReadyTimerId) {
      window.clearTimeout(greetingReadyTimerId);
      greetingReadyTimerId = null;
    }
  }

  function clearGreetingGraceTimer() {
    if (greetingGraceTimerId) {
      window.clearTimeout(greetingGraceTimerId);
      greetingGraceTimerId = null;
    }
  }

  function markCallAudioReady(reason) {
    if (callAudioReady) {
      return;
    }
    callAudioReady = true;
    clearGreetingReadyTimer();
    clearGreetingGraceTimer();
    releaseGreetingMicHold();
    enablePostGreetingTurnDetection();
    console.log("[INFO] Barge-in enabled after greeting:", reason);
    pushDebug("call:audio_ready:" + (reason || "ok"));
  }

  function holdGreetingMic() {
    greetingMicHeld = true;
    if (!localStream) {
      return;
    }
    localStream.getAudioTracks().forEach((track) => {
      track.enabled = false;
    });
    console.log("[INFO] Mic held silent until greeting finishes");
    pushDebug("mic:hold_greeting");
  }

  function releaseGreetingMicHold() {
    if (!greetingMicHeld) {
      return;
    }
    greetingMicHeld = false;
    if (!localStream || isEnding) {
      return;
    }
    localStream.getAudioTracks().forEach((track) => {
      if (track.readyState === "live") {
        track.enabled = true;
      }
    });
    console.log("[INFO] Mic released after greeting");
    pushDebug("mic:release_greeting");
  }

  function scheduleCallAudioReady(reason) {
    if (callAudioReady || greetingGraceTimerId) {
      return;
    }
    // Generation can finish seconds before the headset finishes playing.
    clearGreetingReadyTimer();
    greetingGraceTimerId = window.setTimeout(() => {
      greetingGraceTimerId = null;
      markCallAudioReady(reason);
    }, GREETING_BARGEIN_GRACE_MS);
    pushDebug("greeting:grace");
    console.log(
      "[INFO] Greeting playback ended; enabling barge-in in",
      GREETING_BARGEIN_GRACE_MS,
      "ms"
    );
  }

  function enablePostGreetingTurnDetection() {
    if (!dataChannel || dataChannel.readyState !== "open") {
      return;
    }
    try {
      // Drop any speech captured while greeting was protected.
      dataChannel.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
    } catch (error) {
      console.warn("[WARN] input_audio_buffer.clear failed", error);
    }
    try {
      // Azure replaces audio.input on session.update — re-include transcription
      // or user ASR is wiped right when the caller starts speaking.
      const input = {
        turn_detection: {
          type: turnDetectionConfig.type,
          threshold: turnDetectionConfig.threshold,
          prefix_padding_ms: turnDetectionConfig.prefix_padding_ms,
          silence_duration_ms: turnDetectionConfig.silence_duration_ms,
          create_response: turnDetectionConfig.create_response !== false,
          interrupt_response:
            turnDetectionConfig.interrupt_response !== false,
        },
      };
      if (transcriptLoggingEnabled && transcriptionDeployment) {
        input.transcription = { model: transcriptionDeployment };
      }
      dataChannel.send(
        JSON.stringify({
          type: "session.update",
          session: {
            type: "realtime",
            audio: {
              input,
            },
          },
        })
      );
      pushDebug("vad:barge_in_on");
      console.log("[INFO] Server barge-in re-enabled after greeting");
    } catch (error) {
      console.warn("[WARN] Failed to re-enable barge-in VAD", error);
    }
  }

  function maybeArmGreetingResponse(responseId) {
    if (callAudioReady || !greetingSent || greetingResponseId || !responseId) {
      return;
    }
    greetingResponseId = responseId;
    pushDebug("greeting:response");
  }

  function maybeEnableBargeInAfterGreeting(responseId) {
    if (callAudioReady || !greetingSent) {
      return;
    }
    if (greetingResponseId && responseId && responseId !== greetingResponseId) {
      return;
    }
    // Only unlock on real playback stop — never on response.done
    // (model finishes generating while audio is still playing).
    if (
      greetingAudioStarted ||
      (responseId && greetingResponseId && responseId === greetingResponseId)
    ) {
      scheduleCallAudioReady("greeting_audio_done");
    }
  }

  function onDataChannelMessage(event) {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch (_error) {
      return;
    }

    const type = payload.type || "unknown";
    if (!type.includes("delta")) {
      console.log("[EVENT]", type, payload);
      pushDebug(type);
    }

    switch (type) {
      case "session.created":
        // Wait for session.updated so audio.output.voice (marin) is applied
        // before the first spoken reply — avoids locking a wrong default voice.
        break;
      case "session.updated": {
        const sessionVoice =
          payload.session &&
          payload.session.audio &&
          payload.session.audio.output &&
          payload.session.audio.output.voice
            ? String(payload.session.audio.output.voice).toLowerCase()
            : null;
        const turnDetection =
          payload.session &&
          payload.session.audio &&
          payload.session.audio.input
            ? payload.session.audio.input.turn_detection
            : undefined;
        console.log(
          "[INFO] Session turn_detection:",
          turnDetection === null || turnDetection === undefined
            ? turnDetection
            : {
                interrupt_response: turnDetection.interrupt_response,
                create_response: turnDetection.create_response,
                type: turnDetection.type,
              }
        );
        if (sessionVoice) {
          console.log("[INFO] Session voice confirmed:", sessionVoice);
          pushDebug("voice_ok:" + sessionVoice);
          if (selectedVoice && sessionVoice !== selectedVoice) {
            console.warn(
              "[WARN] Session voice mismatch; expected",
              selectedVoice,
              "got",
              sessionVoice
            );
          }
        }
        sendGreeting();
        break;
      }
      case "input_audio_buffer.speech_started":
        // Ignore mic noise while connecting / before greeting can play.
        if (!callAudioReady || isConnecting) {
          pushDebug("speech:ignored_pre_ready");
          // Discard leaked audio so Azure cannot truncate Hello.
          try {
            if (dataChannel && dataChannel.readyState === "open") {
              dataChannel.send(
                JSON.stringify({ type: "input_audio_buffer.clear" })
              );
            }
          } catch (_error) {
            // ignore
          }
          break;
        }
        assistantRepliesThisUserTurn = 0;
        handleUserBargeIn();
        // Without a user-ASR deployment, mark speech turns so the file still shows timing.
        if (!transcriptionDeployment) {
          appendTranscript("USER", "(started speaking)", "speech_started");
        }
        break;
      case "input_audio_buffer.speech_stopped":
        if (!callAudioReady || isConnecting) {
          pushDebug("speech:ignored_stop_pre_ready");
          break;
        }
        userTurnActive = false;
        bargeInInProgress = false;
        setStatus("Processing...");
        if (!transcriptionDeployment) {
          appendTranscript("USER", "(stopped speaking)", "speech_stopped");
        }
        // After a Tech Cafe / slot offer, coach the next reply so "yes please"
        // advances instead of repeating the same pitch (call-20260913-120311-cffc).
        maybeStartBookingAdvanceCoach();
        break;
      case "conversation.item.input_audio_transcription.completed":
      case "conversation.item.audio_transcription.completed":
        {
          const userText = (payload.transcript || "").trim();
          if (userText) {
            appendTranscript("USER", userText, "asr");
          } else {
            console.warn("[WARN] ASR completed with empty transcript", payload);
            pushDebug("asr:empty");
          }
        }
        break;
      case "conversation.item.input_audio_transcription.failed":
      case "conversation.item.audio_transcription.failed":
        {
          const err =
            (payload.error && (payload.error.message || payload.error.code)) ||
            "transcription failed";
          console.warn("[WARN] User ASR failed:", err, payload);
          pushDebug("asr:failed");
          appendTranscript("USER", "(ASR failed: " + err + ")", "asr_failed");
        }
        break;
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done":
        {
          const assistantText = (payload.transcript || "").trim();
          if (assistantText && !shouldIgnoreAssistantResponse(payload.response_id)) {
            if (
              diagnoseDeliveringResult &&
              diagnoseOwnResponseId &&
              payload.response_id &&
              payload.response_id !== diagnoseOwnResponseId
            ) {
              pushDebug("transcript:skip_non_own");
              break;
            }
            lastAssistantTranscript = assistantText;
            updateBookingOfferStageFromTranscript(assistantText);
            noteSpelledNameFromAssistantSpeech(assistantText);
            appendTranscript("ASSISTANT", assistantText, "speech");
            // Model sometimes speaks goodbye but forgets end_call
            // (call-20260913-132902-a0d2) — hang up from closing farewell speech.
            maybeScheduleHangupFromFarewellSpeech(assistantText);
            maybeCompleteHangupSpeechCheck();
          }
        }
        break;
      case "response.function_call_arguments.done":
        if (shouldIgnoreAssistantResponse(payload.response_id)) {
          pushDebug("tool:ignored_cancelled");
          break;
        }
        handleFunctionCall(payload).catch((error) => {
          console.error("[ERROR] tool call failed", error);
          pushDebug("tool:error");
        });
        break;
      case "response.output_item.added":
        if (payload.item && payload.item.type === "message" && payload.item.id) {
          currentAssistantItemId = payload.item.id;
        }
        // Greeting path: cut ring a beat before audio reaches the headset
        // (Bluetooth often buffers ~100–200ms after Web Audio stop).
        if (
          connectingToneActive &&
          greetingSent &&
          !callAudioReady &&
          payload.item &&
          payload.item.type === "message"
        ) {
          stopConnectingTone();
          pushDebug("ring:stop_pre_audio");
        }
        break;
      case "response.output_item.done":
        if (payload.item && payload.item.type === "function_call") {
          if (shouldIgnoreAssistantResponse(payload.response_id)) {
            pushDebug("tool:ignored_cancelled");
            break;
          }
          handleFunctionCall({
            name: payload.item.name,
            arguments: payload.item.arguments,
            call_id: payload.item.call_id,
            response_id: payload.response_id,
          }).catch((error) => {
            console.error("[ERROR] tool call failed", error);
            pushDebug("tool:error");
          });
        }
        break;
      case "response.created":
        {
          const createdVoice = reportedResponseVoice(payload);
          if (createdVoice) {
            pushDebug("resp_voice:" + createdVoice);
            if (selectedVoice && createdVoice !== selectedVoice) {
              console.warn(
                "[WARN] Response voice mismatch; expected",
                selectedVoice,
                "got",
                createdVoice
              );
            }
          }
        }
        activeResponseId =
          (payload.response && payload.response.id) || payload.response_id || null;
        maybeArmGreetingResponse(activeResponseId);
        if (userTurnActive && activeResponseId) {
          // Premature assistant turn while caller is still speaking — cancel it.
          cancelledResponseIds.add(activeResponseId);
          trimCancelledResponseIds();
          cancelActiveAssistantTurn("premature_during_user");
          break;
        }
        // After end_call + goodbye heard, kill any further chatter from noise turns.
        if (pendingHangup && hangupAudioHeard && activeResponseId) {
          cancelledResponseIds.add(activeResponseId);
          trimCancelledResponseIds();
          cancelActiveAssistantTurn("suppress_post_hangup_reply");
          silenceLocalPlayback();
          pushDebug("hangup:suppress_post_goodbye");
          break;
        }
        // Post-Brain: only ONE coached reply may speak. Autos before we arm are
        // cancelled; the first response.created after arm is ours; later extras
        // are ignored without cancelling an already-speaking own turn.
        if (diagnoseDeliveringResult && activeResponseId) {
          if (!diagnoseSpeakArmed) {
            // Drain late continue-to-hold creates before we arm specialist speak.
            if (holdOutboundPending > 0) {
              holdOutboundPending -= 1;
            }
            cancelledResponseIds.add(activeResponseId);
            trimCancelledResponseIds();
            cancelActiveAssistantTurn("suppress_pre_diagnose_speak");
            silenceLocalPlayback();
            break;
          }
          if (!diagnoseOwnResponseId) {
            // Late continue-to-hold response.create can arrive after we arm
            // (call-20260912-211033-1e05) — never treat hold as specialist.
            if (holdOutboundPending > 0) {
              holdOutboundPending -= 1;
              cancelledResponseIds.add(activeResponseId);
              trimCancelledResponseIds();
              cancelActiveAssistantTurn("suppress_late_hold");
              silenceLocalPlayback();
              pushDebug("hold:suppress_late");
              break;
            }
            diagnoseOwnResponseId = activeResponseId;
            assistantResponseActive = true;
            pushDebug("tool:own_response");
            break;
          }
          if (activeResponseId !== diagnoseOwnResponseId) {
            cancelledResponseIds.add(activeResponseId);
            trimCancelledResponseIds();
            if (aiSpeaking && diagnoseOwnResponseId) {
              activeResponseId = diagnoseOwnResponseId;
              pushDebug("tool:ignore_extra_keep_own");
            } else {
              silenceLocalPlayback();
              cancelActiveAssistantTurn("suppress_extra_diagnose_speak");
              pushDebug("tool:suppress_extra");
            }
            break;
          }
        }
        // Hold continue-to-hold lines (before specialist delivery arms).
        if (holdOutboundPending > 0 && !diagnoseSpeakArmed && activeResponseId) {
          holdOutboundPending -= 1;
          assistantResponseActive = true;
          pushDebug("hold:response");
          break;
        }
        // Tech Cafe booking advance: kill autos until armed; claim first as own.
        if (bookingAdvancePending && activeResponseId) {
          if (!bookingAdvanceArmed) {
            cancelledResponseIds.add(activeResponseId);
            trimCancelledResponseIds();
            cancelActiveAssistantTurn("suppress_pre_booking_advance");
            silenceLocalPlayback();
            pushDebug("booking:suppress_auto");
            break;
          }
          if (!bookingAdvanceOwnResponseId) {
            bookingAdvanceOwnResponseId = activeResponseId;
            assistantResponseActive = true;
            pushDebug("booking:own_response");
            break;
          }
          if (activeResponseId !== bookingAdvanceOwnResponseId) {
            cancelledResponseIds.add(activeResponseId);
            trimCancelledResponseIds();
            silenceLocalPlayback();
            cancelActiveAssistantTurn("suppress_extra_booking_advance");
            pushDebug("booking:suppress_extra");
            break;
          }
        }
        // One spoken reply per user turn (skip hold / hangup / diagnose / booking paths).
        if (
          activeResponseId &&
          !diagnoseDeliveringResult &&
          !diagnoseHoldInFlight &&
          !bookingAdvancePending &&
          !pendingHangup
        ) {
          assistantRepliesThisUserTurn += 1;
          if (assistantRepliesThisUserTurn > 1) {
            cancelledResponseIds.add(activeResponseId);
            trimCancelledResponseIds();
            cancelActiveAssistantTurn("suppress_double_reply");
            silenceLocalPlayback();
            pushDebug("tool:suppress_double_reply");
            console.log("[INFO] Suppressed extra assistant reply with no new user speech");
            break;
          }
        }
        assistantResponseActive = true;
        break;
      case "response.cancelled":
        if (activeResponseId) {
          cancelledResponseIds.add(activeResponseId);
          trimCancelledResponseIds();
        }
        assistantResponseActive = false;
        aiSpeaking = false;
        break;
      case "response.done":
        assistantResponseActive = false;
        {
          const doneResponseId =
            (payload.response && payload.response.id) || payload.response_id || null;
          // Do not unlock barge-in on response.done — audio may still be playing.
          // Only clear diagnose gate when OUR coached reply finishes — not when
          // a cancelled auto-reply's response.done arrives.
          if (
            diagnoseDeliveringResult &&
            diagnoseOwnResponseId &&
            doneResponseId === diagnoseOwnResponseId
          ) {
            // Hold line wrongly accepted as own → retry specialist once.
            if (
              looksLikeHoldLine(lastAssistantTranscript) &&
              diagnoseSpeakRequested &&
              diagnoseLastOutput
            ) {
              console.warn("[WARN] Hold line claimed as specialist; retrying speak");
              pushDebug("tool:retry_after_hold_collision");
              diagnoseOwnResponseId = null;
              diagnoseSpeakArmed = true;
              diagnoseSpeakSentAt = Date.now();
              if (dataChannel && dataChannel.readyState === "open") {
                sendAudioResponse({
                  tool_choice: "none",
                  instructions: buildDiagnoseSpeakInstructions(diagnoseLastOutput),
                });
              }
            } else {
              diagnoseSpeakRequested = false;
              diagnoseSpeakArmed = false;
              diagnoseDeliveringResult = false;
              diagnoseOwnResponseId = null;
              enableLocalPlayback();
              if (diagnoseSpeakRetryTimerId) {
                window.clearTimeout(diagnoseSpeakRetryTimerId);
                diagnoseSpeakRetryTimerId = null;
              }
            }
          }
          if (
            bookingAdvancePending &&
            bookingAdvanceOwnResponseId &&
            doneResponseId === bookingAdvanceOwnResponseId
          ) {
            // If model still re-pitched Tech Cafe, retry once with stricter coach.
            if (
              bookingOfferStage === "techcafe_pitch" &&
              looksLikeTechCafePitch(lastAssistantTranscript) &&
              !looksLikeSlotOffer(lastAssistantTranscript)
            ) {
              console.warn("[WARN] Booking advance still re-pitched; retrying");
              pushDebug("booking:retry_advance");
              bookingAdvanceOwnResponseId = null;
              bookingAdvanceArmed = true;
              sendAudioResponse({
                tool_choice: "none",
                instructions: buildBookingAdvanceInstructions(true),
              });
            } else {
              clearBookingAdvanceState();
              enableLocalPlayback();
            }
          }
        }
        {
          const usage =
            (payload.response && payload.response.usage) || payload.usage || null;
          const promptDetails =
            (usage &&
              (usage.input_token_details ||
                usage.prompt_tokens_details ||
                usage.input_tokens_details)) ||
            null;
          const cachedTokens =
            promptDetails && typeof promptDetails.cached_tokens === "number"
              ? promptDetails.cached_tokens
              : null;
          if (cachedTokens !== null) {
            console.log("[INFO] Realtime cached_tokens=", cachedTokens, usage);
            pushDebug("rt_cache:" + cachedTokens);
          }
        }
        if (shouldIgnoreAssistantResponse(payload.response_id || activeResponseId)) {
          break;
        }
        if (pendingHangup && !aiSpeaking && !hangupAudioHeard) {
          requestGoodbyeBeforeHangup();
        } else if (!pendingHangup && !aiSpeaking && !userTurnActive) {
          setStatus("Listening...");
        }
        break;
      case "output_audio_buffer.started":
        if (userTurnActive || shouldIgnoreAssistantResponse(activeResponseId)) {
          // Stale/cancelled audio — keep silent and clear again.
          silenceLocalPlayback();
          cancelActiveAssistantTurn("stale_audio");
          break;
        }
        // Post-Brain / booking-advance: never unmute until the coached response is playing.
        if (
          diagnoseDeliveringResult &&
          (!diagnoseOwnResponseId || activeResponseId !== diagnoseOwnResponseId)
        ) {
          silenceLocalPlayback();
          if (activeResponseId) {
            cancelledResponseIds.add(activeResponseId);
            trimCancelledResponseIds();
          }
          cancelActiveAssistantTurn("diagnose_block_non_own_audio");
          pushDebug("audio:blocked_non_own");
          break;
        }
        if (
          bookingAdvancePending &&
          (!bookingAdvanceOwnResponseId ||
            activeResponseId !== bookingAdvanceOwnResponseId)
        ) {
          silenceLocalPlayback();
          if (activeResponseId) {
            cancelledResponseIds.add(activeResponseId);
            trimCancelledResponseIds();
          }
          cancelActiveAssistantTurn("booking_block_non_own_audio");
          pushDebug("audio:blocked_booking_non_own");
          break;
        }
        aiSpeaking = true;
        assistantResponseActive = true;
        assistantPlayStartedAt = Date.now();
        stopConnectingTone();
        enableLocalPlayback();
        if (greetingSent && !callAudioReady) {
          greetingAudioStarted = true;
          // Barge-in stays off until this greeting finishes playing.
        }
        setStatus(pendingHangup ? "Saying goodbye..." : "AI speaking...");
        // Only count as hangup goodbye once we've committed to a farewell turn
        // (requested goodbye, or speech check already confirmed farewell).
        if (pendingHangup && (hangupGoodbyeRequested || !hangupAwaitingSpeechCheck)) {
          hangupAudioHeard = true;
          pushDebug("hangup:audio_started");
        }
        break;
      case "output_audio_buffer.cleared":
        aiSpeaking = false;
        assistantPlayStartedAt = null;
        pushDebug("audio:cleared");
        break;
      case "output_audio_buffer.stopped":
        maybeEnableBargeInAfterGreeting(
          payload.response_id || activeResponseId
        );
        aiSpeaking = false;
        assistantPlayStartedAt = null;
        lastAssistantAudioStoppedAt = Date.now();
        if (pendingHangup && hangupAwaitingSpeechCheck) {
          // transcript.done often arrives just after audio stop — wait briefly
          window.setTimeout(() => maybeCompleteHangupSpeechCheck(), 450);
          break;
        }
        if (pendingHangup && hangupAudioHeard) {
          setStatus("Ending call...");
          pushDebug("hangup:audio_done");
          if (hangupGraceTimerId) {
            window.clearTimeout(hangupGraceTimerId);
          }
          hangupGraceTimerId = window.setTimeout(() => finishHangup(), 1500);
        } else if (pendingHangup && !hangupAudioHeard) {
          requestGoodbyeBeforeHangup();
        } else if (!userTurnActive && !bargeInInProgress) {
          setStatus("Listening...");
        }
        break;
      case "error":
      case "session.error":
        {
          const errObj = payload.error || {};
          const errMsg =
            errObj.message || errObj.code || payload.message || "";
          const lower = String(errMsg).toLowerCase();
          const code = String(errObj.code || errObj.type || "").toLowerCase();
          // Expected when barge-in cancels an already-finished response.
          if (
            lower.includes("no active response") ||
            lower.includes("no response to cancel") ||
            lower.includes("not active") ||
            lower.includes("cancellation") ||
            code.includes("response_cancel")
          ) {
            console.log("[INFO] Realtime benign error:", errMsg || code || payload);
            pushDebug("rt_err:benign");
            break;
          }
          if (
            diagnoseHoldInFlight &&
            (lower.includes("function") ||
              lower.includes("tool") ||
              lower.includes("active response") ||
              lower.includes("conversation"))
          ) {
            // Pending consult_helpdesk_expert often blocks mid-wait Realtime speech.
            diagnoseHoldUseRealtime = false;
            pushDebug("hold:fallback_tts");
            speakLocalHoldLine(buildHoldLine(true));
            break;
          }
          console.error("[ERROR] Realtime", payload);
          setStatus((payload.error && payload.error.message) || "Connection failed");
        }
        break;
      default:
        break;
    }
  }

  function trimCancelledResponseIds() {
    while (cancelledResponseIds.size > 24) {
      const first = cancelledResponseIds.values().next().value;
      cancelledResponseIds.delete(first);
    }
  }

  function shouldIgnoreAssistantResponse(responseId) {
    if (!responseId) {
      return userTurnActive;
    }
    return cancelledResponseIds.has(responseId) || userTurnActive;
  }

  function silenceLocalPlayback() {
    if (remoteAudio) {
      remoteAudio.muted = true;
    }
  }

  function enableLocalPlayback() {
    if (!remoteAudio) {
      return;
    }
    remoteAudio.muted = false;
    remoteAudio.volume = 1.0;
    const playPromise = remoteAudio.play();
    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch((error) => {
        console.warn("[WARN] remoteAudio.play failed", error);
      });
    }
  }

  function detachContextRemoteRoute() {
    if (remoteStreamAudioSource) {
      try {
        remoteStreamAudioSource.disconnect();
      } catch (_error) {
        // ignore
      }
      remoteStreamAudioSource = null;
    }
  }

  function attachRemoteAudioStream(stream) {
    if (!stream) {
      return;
    }
    // Use ONE playback path only. Playing the same WebRTC stream through both
    // <audio> and AudioContext caused echo on Shokz (call console 12:29).
    if (
      attachedRemoteStream === stream &&
      remoteAudio &&
      remoteAudio.srcObject === stream
    ) {
      enableLocalPlayback();
      return;
    }
    attachedRemoteStream = stream;
    detachContextRemoteRoute();

    if (!remoteAudio) {
      remoteAudio = document.createElement("audio");
      remoteAudio.autoplay = true;
      remoteAudio.preload = "auto";
      remoteAudio.setAttribute("playsinline", "true");
      document.body.appendChild(remoteAudio);
    }
    try {
      remoteAudio.removeAttribute("src");
      remoteAudio.srcObject = stream;
    } catch (error) {
      console.warn("[WARN] remoteAudio srcObject failed", error);
    }
    remoteAudio.muted = false;
    remoteAudio.volume = 1.0;
    remotePlaybackMode = "element";
    setElementOutputSink(remoteAudio).catch(() => {});
    remoteAudio.play().catch((error) => {
      console.warn(
        "[WARN] remoteAudio.play failed; falling back to AudioContext",
        error
      );
      pushDebug("remote_play_fail");
      attachRemoteAudioViaContext(stream);
    });
    console.log("[INFO] Remote audio via HTMLAudioElement (single path)");
    pushDebug("remote:element");
  }

  function attachRemoteAudioViaContext(stream) {
    ensureOutputAudioContextRunning();
    if (!outputAudioContext || !stream) {
      return;
    }
    try {
      detachContextRemoteRoute();
      // Mute element so we do not double-play.
      if (remoteAudio) {
        remoteAudio.muted = true;
        try {
          remoteAudio.srcObject = null;
        } catch (_error) {
          // ignore
        }
      }
      remoteStreamAudioSource = outputAudioContext.createMediaStreamSource(stream);
      remoteStreamAudioSource.connect(outputAudioContext.destination);
      remotePlaybackMode = "context";
      attachedRemoteStream = stream;
      pushDebug("remote:context");
      console.log(
        "[INFO] Remote audio via AudioContext only; state=",
        outputAudioContext.state
      );
    } catch (error) {
      console.warn("[WARN] AudioContext remote route failed", error);
      pushDebug("remote_ctx:fail");
    }
  }

  function ensureOutputAudioContextRunning() {
    if (!outputAudioContext) {
      return;
    }
    if (outputAudioContext.state === "suspended") {
      outputAudioContext.resume().catch((error) => {
        console.warn("[WARN] output AudioContext resume failed", error);
      });
    }
  }

  async function applyOutputDeviceRouting() {
    // Resolve the OS-selected output (prefer same device group as the active
    // mic), then bind ringtone HTMLAudio, remote AI <audio>, and AudioContext
    // to that one sink so Bluetooth HFP does not leave ring on built-in speakers.
    try {
      await rebindOutputToOsDefault();
    } catch (error) {
      console.warn("[WARN] applyOutputDeviceRouting failed", error);
      pushDebug("sink:fail");
    }
  }

  async function resolvePreferredOutputSinkId() {
    preferredOutputSinkId = "default";
    try {
      // Explicit speaker dropdown wins over OS role aliases.
      const selectedSpeaker = getSelectedSpeakerDeviceId();
      if (selectedSpeaker && selectedSpeaker !== "default") {
        preferredOutputSinkId = selectedSpeaker;
        console.log("[INFO] Output sink from user selection:", selectedSpeaker);
        pushDebug("sink:user");
        return preferredOutputSinkId;
      }

      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
        return preferredOutputSinkId;
      }
      const devices = await navigator.mediaDevices.enumerateDevices();
      const outputs = devices.filter((device) => device.kind === "audiooutput");
      if (outputs.length === 0) {
        return preferredOutputSinkId;
      }

      // "System default" = Windows currently selected call/output device.
      // Prefer communications (Default Communications Device — often the
      // headset in use) over multimedia "default" (which may still be
      // laptop speakers while the user is on another device).
      const communications = outputs.find(
        (device) => device.deviceId === "communications"
      );
      if (communications) {
        preferredOutputSinkId = "communications";
        console.log(
          "[INFO] Output sink: Windows communications (current call device)",
          communications.label || ""
        );
        pushDebug("sink:communications");
        return preferredOutputSinkId;
      }

      const defaultOut = outputs.find((device) => device.deviceId === "default");
      if (defaultOut) {
        preferredOutputSinkId = "default";
        console.log(
          "[INFO] Output sink: Windows default",
          defaultOut.label || ""
        );
        pushDebug("sink:default");
        return preferredOutputSinkId;
      }
    } catch (error) {
      console.warn("[WARN] resolvePreferredOutputSinkId failed", error);
    }
    return preferredOutputSinkId;
  }

  async function rebindOutputToOsDefault() {
    // Mic open often switches Windows to Headset (HFP). Recreate AudioContext
    // AFTER that so Web Audio is not stuck on the pre-call speaker sink.
    killConnectingToneNodes();
    await resolvePreferredOutputSinkId();
    const sinkId = preferredOutputSinkId || "default";
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const previousCtx = outputAudioContext;
    if (AudioCtx) {
      try {
        outputAudioContext = new AudioCtx();
        if (outputAudioContext.state === "suspended") {
          await outputAudioContext.resume().catch(() => {});
        }
        if (typeof outputAudioContext.setSinkId === "function") {
          try {
            await outputAudioContext.setSinkId(sinkId);
          } catch (sinkError) {
            console.warn(
              "[WARN] AudioContext setSinkId failed; falling back to default",
              sinkError
            );
            if (sinkId !== "default") {
              await outputAudioContext.setSinkId("default").catch(() => {});
            }
          }
        }
      } catch (error) {
        console.warn("[WARN] AudioContext OS-default bind failed", error);
        if (!outputAudioContext || outputAudioContext.state === "closed") {
          outputAudioContext = previousCtx;
        }
      }
    }
    if (
      previousCtx &&
      previousCtx !== outputAudioContext &&
      previousCtx.state !== "closed"
    ) {
      try {
        await previousCtx.close();
      } catch (_error) {
        // ignore
      }
    }

    await setElementOutputSink(remoteAudio);
    await setElementOutputSink(connectingToneAudio);

    console.log("[INFO] Playback bound to OS output sink:", sinkId);
    pushDebug("sink:bound");
    ensureOutputAudioContextRunning();
    if (remoteAudio && remoteAudio.srcObject) {
      enableLocalPlayback();
    }
  }

  async function setElementOutputSink(audioEl) {
    if (!audioEl || typeof audioEl.setSinkId !== "function") {
      return;
    }
    const sinkId = preferredOutputSinkId || "default";
    try {
      await audioEl.setSinkId(sinkId);
    } catch (error) {
      console.warn("[WARN] setSinkId failed for", sinkId, error);
      if (sinkId !== "default") {
        try {
          await audioEl.setSinkId("default");
        } catch (fallbackError) {
          console.warn("[WARN] setSinkId(default) failed", fallbackError);
        }
      }
    }
  }

  // Back-compat alias used by older call sites / mental model.
  async function setElementSinkToOsDefault(audioEl) {
    return setElementOutputSink(audioEl);
  }

  function stopOutputAudioContext() {
    if (remoteStreamAudioSource) {
      try {
        remoteStreamAudioSource.disconnect();
      } catch (_error) {
        // ignore
      }
      remoteStreamAudioSource = null;
    }
    if (outputAudioContext) {
      try {
        outputAudioContext.close();
      } catch (_error) {
        // ignore
      }
      outputAudioContext = null;
    }
  }

  function cancelActiveAssistantTurn(reason) {
    if (!dataChannel || dataChannel.readyState !== "open") {
      return;
    }
    // Avoid response.cancel when nothing is playing — Azure returns a noisy
    // error after barge-in on an already-finished greeting.
    if (!assistantResponseActive && !aiSpeaking && !activeResponseId) {
      pushDebug("cancel:skip_idle:" + reason);
      return;
    }
    console.log("[INFO] Cancel assistant turn:", reason);
    pushDebug("cancel:" + reason);
    try {
      dataChannel.send(JSON.stringify({ type: "response.cancel" }));
    } catch (error) {
      console.warn("[WARN] response.cancel failed", error);
    }
    try {
      dataChannel.send(JSON.stringify({ type: "output_audio_buffer.clear" }));
    } catch (error) {
      console.warn("[WARN] output_audio_buffer.clear failed", error);
    }
  }

  function handleUserBargeIn() {
    if (!callAudioReady || isConnecting) {
      pushDebug("barge-in:ignored_pre_ready");
      return;
    }
    setStatus("Hearing you...");
    userTurnActive = true;

    // After end_call, commit to hangup — do not abort on barge-in/noise.
    // If farewell is already playing/heard, finish soon; otherwise keep waiting
    // for the real goodbye (do not treat noise as "goodbye heard").
    if (pendingHangup) {
      pushDebug("hangup:ignore_barge_in");
      console.log("[INFO] Ignoring barge-in during hangup; still ending call");
      if (activeResponseId) {
        cancelledResponseIds.add(activeResponseId);
        trimCancelledResponseIds();
      }
      silenceLocalPlayback();
      aiSpeaking = false;
      assistantResponseActive = false;
      cancelActiveAssistantTurn("hangup_ignore_barge_in");
      if (hangupAudioHeard) {
        if (hangupGraceTimerId) {
          window.clearTimeout(hangupGraceTimerId);
        }
        hangupGraceTimerId = window.setTimeout(() => finishHangup(), 600);
      }
      return;
    }

    // Always mark barge-in so late audio/events from the prior turn are ignored.
    bargeInInProgress = true;
    if (activeResponseId) {
      cancelledResponseIds.add(activeResponseId);
      trimCancelledResponseIds();
    }

    const playedMs =
      assistantPlayStartedAt != null ? Math.max(0, Date.now() - assistantPlayStartedAt) : null;
    const truncateItemId = currentAssistantItemId;

    // Immediately silence local playback (do not toggle mic — Bluetooth-safe).
    silenceLocalPlayback();
    aiSpeaking = false;
    assistantResponseActive = false;

    if (!dataChannel || dataChannel.readyState !== "open") {
      assistantPlayStartedAt = null;
      return;
    }

    console.log("[INFO] Barge-in: abandon current AI response (cancelled, not paused)");
    pushDebug("barge-in");
    appendTranscript("SYSTEM", "Caller interrupted AI; response cancelled", "barge_in");

    cancelActiveAssistantTurn("barge_in");

    // Truncate assistant history to audio actually heard so the model does not
    // treat the unheard remainder as already spoken (avoids resume/paraphrase).
    if (truncateItemId && playedMs != null) {
      try {
        dataChannel.send(
          JSON.stringify({
            type: "conversation.item.truncate",
            item_id: truncateItemId,
            content_index: 0,
            audio_end_ms: playedMs,
          })
        );
        pushDebug("truncate:" + playedMs + "ms");
      } catch (error) {
        console.warn("[WARN] conversation.item.truncate failed", error);
      }
    }

    assistantPlayStartedAt = null;
    currentAssistantItemId = null;
  }

  async function handleFunctionCall(payload) {
    const name = payload.name;
    const callId = payload.call_id;
    const rawArgs = payload.arguments || "{}";

    if (!name || !callId) {
      return;
    }
    if (handledCallIds.has(callId)) {
      return;
    }
    handledCallIds.add(callId);

    if (name === "end_call") {
      let reason = "done";
      let parsed = null;
      try {
        parsed = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;
        if (parsed && parsed.reason) {
          reason = String(parsed.reason);
        }
      } catch (_error) {
        parsed = null;
      }
      const ticketFields = buildTicketFieldsFromEndCall(parsed, reason);
      mergeTicketDraft(ticketFields);
      pendingTicketFields = ticketFields;
      console.log("[INFO] end_call", reason, "aiSpeaking=", aiSpeaking, "ticket=", ticketFields);
      pushDebug("tool:end_call");
      appendTranscript(
        "TOOL",
        JSON.stringify({ reason, ...ticketFields }),
        "end_call"
      );
      submitCallTicket(ticketFields, true);
      await sendToolOutput(callId, { ok: true, action: "wait_for_goodbye_then_hangup" }, false);
      scheduleHangup(reason);
      return;
    }

    if (name !== "consult_helpdesk_expert") {
      console.warn("[WARN] Unknown tool:", name);
      await sendToolOutput(callId, { error: "Unknown tool: " + name });
      return;
    }

    setStatus("Consulting gpt-6-astra...");
    pushDebug("tool:gpt-6-astra");
    console.log("[INFO] consult_helpdesk_expert", rawArgs);

    let args;
    try {
      args = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;
    } catch (_error) {
      args = { issue_summary: String(rawArgs) };
    }

    mergeTicketDraft({
      caller_name: args && args.caller_name,
      problem_summary: args && args.issue_summary,
    });

    diagnoseHoldLanguage = (args && args.caller_language) || "English";
    // Start hold prompts only after the short expert-start request succeeds,
    // so iOS does not reset the POST body mid-upload (ConnectionResetError).
    let holdStarted = false;

    let output = { error: "Diagnostic request failed" };
    try {
      const consultBody = transcriptId ? { ...args, _transcript_id: transcriptId } : args;
      const consultResult = await postHelpdeskConsult(consultBody, () => {
        if (!holdStarted) {
          holdStarted = true;
          startDiagnoseHoldPrompts();
        }
      });
      if (!consultResult.ok) {
        output = {
          error: consultResult.detail || "Diagnostic request failed",
          speak_to_caller:
            "Continue with a normal safe first troubleshooting step. " +
            "Do not tell the caller the specialist consult failed or did not come through.",
        };
        appendTranscript(
          "TOOL_RESULT",
          consultResult.detail || "consult failed",
          "diagnose_error"
        );
      } else {
        const data = consultResult.data;
        output = data.result || data;
        console.log("[INFO] gpt-6-astra diagnose result", output);
        if (typeof data.cached_tokens !== "undefined") {
          console.log("[INFO] prompt cached_tokens=", data.cached_tokens);
          pushDebug("cache:" + data.cached_tokens);
        }
        pushDebug("tool:done:" + (output.path || "ok"));
      }
    } catch (error) {
      console.error("[ERROR] diagnose fetch failed", error);
      output = {
        error: (error && error.message) || "Diagnostic request failed",
        speak_to_caller:
          "Continue with a normal safe first troubleshooting step. " +
          "Do not tell the caller the specialist consult failed or did not come through.",
      };
      appendTranscript(
        "TOOL_RESULT",
        (error && error.message) || "fetch failed",
        "diagnose_error"
      );
      pushDebug("tool:fetch_error");
    } finally {
      if (!holdStarted) {
        // Ensure we still clear any UI state even if start never ran.
      }
      stopDiagnoseHoldPrompts(true);
    }

    await deliverDiagnoseToolResult(callId, output);
  }

  function buildDiagnoseSpeakInstructions(output) {
    const speak =
      output && typeof output.speak_to_caller === "string"
        ? output.speak_to_caller.trim()
        : "";
    const nextQ =
      output && Array.isArray(output.next_questions)
        ? output.next_questions.filter(Boolean).slice(0, 2)
        : [];
    const nextA =
      output && Array.isArray(output.next_actions)
        ? output.next_actions.filter(Boolean).slice(0, 1)
        : [];
    let guidance =
      "The diagnostic specialist result just arrived. Speak ONE complete reply to the caller now. " +
      "Do not stop mid-sentence. Do not start a second message. Do not call any tools. " +
      "Use the same session voice (" +
      (selectedVoice || "marin") +
      ") — do not switch voice, accent, or announcer style. " +
      "Speak in the caller's latest content language (" +
      (diagnoseHoldLanguage || "English") +
      ") — match spoken issue content, not English-looking names. " +
      "Use phone style: at most 1-2 short NEW questions OR one clear next action. " +
      "ANTI-DOUBLE-ASK: Do not re-ask anything the caller already confirmed earlier in this call " +
      "(office vs remote/home, exact error text already given, intranet/VPN working, logged into Windows, etc.). " +
      "If specialist coaching repeats a settled fact as a question, drop that question and advance.";
    if (speak) {
      guidance +=
        " Prefer this coaching line (natural spoken paraphrase is OK, keep the same intent, " +
        "but strip any re-asks of settled facts): " +
        JSON.stringify(speak);
    }
    if (nextQ.length) {
      guidance +=
        " Optional NEW questions only (skip if already answered): " +
        JSON.stringify(nextQ) +
        ".";
    }
    if (nextA.length) {
      guidance += " Optional action to weave in: " + JSON.stringify(nextA) + ".";
    }
    if (output && output.error && !speak) {
      guidance +=
        " The specialist payload had an error flag; give one safe next troubleshooting step. " +
        "Do not mention backend or specialist failure.";
    }
    return guidance;
  }

  async function waitForAssistantQuiet(maxMs) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      if (!aiSpeaking && !assistantResponseActive) {
        return true;
      }
      await delay(100);
    }
    cancelActiveAssistantTurn("force_quiet");
    await delay(200);
    aiSpeaking = false;
    assistantResponseActive = false;
    return false;
  }

  async function deliverDiagnoseToolResult(callId, output) {
    // 1) Mute + kill Azure auto-reply after function_call_output
    // 2) Drain late continue-to-hold creates (holdOutboundPending)
    // 3) Arm and create ONE coached reply (first response.created after arm = ours)
    // 4) Unmute only when that response's audio starts
    // (164950-d12d: time-gate cancelled our own create → permanent silence)
    // (211033-1e05: late hold claimed as own → silence until barge-in)
    diagnoseDeliveringResult = true;
    diagnoseLastOutput = output;
    diagnoseSpeakRequested = false;
    diagnoseSpeakArmed = false;
    diagnoseOwnResponseId = null;
    diagnoseSpeakSentAt = 0;
    if (diagnoseSpeakRetryTimerId) {
      window.clearTimeout(diagnoseSpeakRetryTimerId);
      diagnoseSpeakRetryTimerId = null;
    }

    stopDiagnoseHoldPrompts(true);
    cancelActiveAssistantTurn("diagnose_ready");
    silenceLocalPlayback();
    await waitForAssistantQuiet(1000);

    if (!dataChannel || dataChannel.readyState !== "open") {
      diagnoseDeliveringResult = false;
      enableLocalPlayback();
      return;
    }
    if (userTurnActive || bargeInInProgress) {
      dataChannel.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: callId,
            output: JSON.stringify(output),
          },
        })
      );
      diagnoseDeliveringResult = false;
      enableLocalPlayback();
      pushDebug("tool:output_no_speak");
      return;
    }

    dataChannel.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify(output),
        },
      })
    );

    const killUntil = Date.now() + DIAGNOSE_AUTO_KILL_MS;
    while (Date.now() < killUntil) {
      if (assistantResponseActive || aiSpeaking) {
        cancelActiveAssistantTurn("diagnose_kill_auto");
        aiSpeaking = false;
        assistantResponseActive = false;
        silenceLocalPlayback();
      }
      await delay(100);
    }
    cancelActiveAssistantTurn("diagnose_before_speak");
    silenceLocalPlayback();
    await waitForAssistantQuiet(400);
    await delay(200);
    cancelActiveAssistantTurn("diagnose_settle");
    silenceLocalPlayback();

    // Wait out any continue-to-hold still in flight so it is cancelled while
    // unarmed — never arm while a hold create can still be claimed as "own".
    const drainUntil = Date.now() + 2500;
    while (Date.now() < drainUntil) {
      if (assistantResponseActive || aiSpeaking) {
        cancelActiveAssistantTurn("diagnose_drain_hold");
        aiSpeaking = false;
        assistantResponseActive = false;
        silenceLocalPlayback();
      }
      if (holdOutboundPending <= 0 && !assistantResponseActive && !aiSpeaking) {
        break;
      }
      await delay(50);
    }
    holdOutboundPending = 0;

    diagnoseSpeakRequested = true;
    diagnoseSpeakArmed = true;
    diagnoseOwnResponseId = null;
    diagnoseSpeakSentAt = Date.now();
    sendAudioResponse({
      tool_choice: "none",
      instructions: buildDiagnoseSpeakInstructions(output),
    });
    setStatus("AI speaking...");
    pushDebug("tool:speak_once");

    diagnoseSpeakRetryTimerId = window.setTimeout(() => {
      diagnoseSpeakRetryTimerId = null;
      if (
        !diagnoseSpeakRequested ||
        !diagnoseDeliveringResult ||
        aiSpeaking ||
        userTurnActive ||
        bargeInInProgress ||
        !dataChannel ||
        dataChannel.readyState !== "open"
      ) {
        return;
      }
      console.warn("[WARN] Diagnose speak did not start; retrying once");
      pushDebug("tool:speak_retry");
      cancelActiveAssistantTurn("diagnose_speak_retry");
      silenceLocalPlayback();
      diagnoseSpeakArmed = true;
      diagnoseOwnResponseId = null;
      diagnoseSpeakSentAt = Date.now();
      sendAudioResponse({
        tool_choice: "none",
        instructions: buildDiagnoseSpeakInstructions(output),
      });
    }, 3500);

    window.setTimeout(() => {
      if (diagnoseDeliveringResult && !aiSpeaking) {
        diagnoseDeliveringResult = false;
        diagnoseSpeakRequested = false;
        diagnoseSpeakArmed = false;
        diagnoseOwnResponseId = null;
        enableLocalPlayback();
      }
    }, 20000);
  }

  function startDiagnoseHoldPrompts() {
    stopDiagnoseHoldPrompts(false);
    diagnoseHoldInFlight = true;
    // Prefer Realtime (same marin voice as the agent). Local TTS is fallback only.
    diagnoseHoldUseRealtime = true;
    // Remind every 5s while Brain is still running (not after it returns).
    diagnoseHoldTimerId = window.setInterval(() => {
      speakDiagnoseHoldLine(true);
    }, DIAGNOSE_HOLD_MS);
    pushDebug("hold:started");
  }

  function stopDiagnoseHoldPrompts(cancelSpeaking) {
    if (diagnoseHoldTimerId) {
      window.clearInterval(diagnoseHoldTimerId);
      diagnoseHoldTimerId = null;
    }
    const wasHolding = diagnoseHoldInFlight;
    diagnoseHoldInFlight = false;
    if (window.speechSynthesis) {
      try {
        window.speechSynthesis.cancel();
      } catch (_error) {
        // ignore
      }
    }
    if (cancelSpeaking && wasHolding) {
      cancelActiveAssistantTurn("hold_done");
    }
    if (wasHolding) {
      pushDebug("hold:stopped");
    }
  }

  function speakDiagnoseHoldLine(isFollowUp) {
    if (!diagnoseHoldInFlight || diagnoseDeliveringResult || isEnding || pendingHangup) {
      return;
    }
    if (userTurnActive || bargeInInProgress) {
      return;
    }
    // Avoid stacking over an in-progress hold line or other AI audio.
    if (aiSpeaking || assistantResponseActive) {
      return;
    }

    const line = buildHoldLine(isFollowUp);
    setStatus("Please hold...");
    pushDebug("hold:speak");

    if (diagnoseHoldUseRealtime && dataChannel && dataChannel.readyState === "open") {
      try {
        holdOutboundPending += 1;
        if (
          !sendAudioResponse({
            tool_choice: "none",
            instructions:
              "The diagnostic expert tool is still running. Speak ONLY this short hold line " +
              "in the same session voice (" +
              (selectedVoice || "marin") +
              "), then stop completely. " +
              "Do not call any tools. Do not give troubleshooting yet. " +
              "Do not change voice, accent, or speaking style. Exact line: " +
              JSON.stringify(line),
          })
        ) {
          holdOutboundPending = Math.max(0, holdOutboundPending - 1);
          throw new Error("data channel not open");
        }
        return;
      } catch (error) {
        holdOutboundPending = Math.max(0, holdOutboundPending - 1);
        console.warn("[WARN] Realtime hold line failed; using local TTS", error);
        diagnoseHoldUseRealtime = false;
      }
    }

    speakLocalHoldLine(line);
  }

  async function postHelpdeskConsult(body, onStarted) {
    // Prefer persistent WSS control channel (opened at call start). iPhone
    // WebRTC + self-signed HTTPS often breaks mid-call fetch POST/GET.
    const argsOnly = { ...body };
    delete argsOnly._transcript_id;
    const tid = body._transcript_id || transcriptId || "";

    consultHttpBusy = true;
    pingClientLog("consult_attempt", (argsOnly.issue_summary || "").slice(0, 120));

    let startData = { ok: false, detail: "Diagnostic request failed" };

    // 1) WebSocket primary
    try {
      if (!controlWs || controlWs.readyState !== WebSocket.OPEN) {
        await openControlSocket();
      }
      const wsStart = await wsRequest(
        "expert_start",
        { args: argsOnly, transcript_id: tid || "" },
        15000
      );
      if (wsStart && wsStart.ok && wsStart.job_id) {
        startData = { ok: true, job_id: wsStart.job_id, via: "ws" };
        pingClientLog("consult_start_ok", "via=ws job=" + wsStart.job_id);
      } else {
        startData = {
          ok: false,
          detail: (wsStart && wsStart.error) || "WebSocket expert start failed",
        };
        pingClientLog("consult_start_ws_fail", startData.detail);
      }
    } catch (error) {
      startData = {
        ok: false,
        detail: (error && error.message) || "WebSocket failed",
      };
      console.warn("[WARN] expert start via WebSocket", startData.detail);
      pingClientLog("consult_start_ws_net", startData.detail);
    }

    // 2) GET start-get fallback (bypass HTTP queue — do not wait on transcript POSTs)
    if (!startData.ok) {
      try {
        const getUrl = new URL(
          "/api/transcript/expert/start-get",
          window.location.origin
        );
        getUrl.searchParams.set("d", toBase64UrlJson(argsOnly));
        if (tid) {
          getUrl.searchParams.set("tid", tid);
        }
        const getResponse = await fetchWithTimeout(
          getUrl.toString(),
          { method: "GET", cache: "no-store", credentials: "same-origin" },
          12000
        );
        if (getResponse.ok) {
          const data = await getResponse.json();
          if (data.job_id) {
            startData = { ok: true, job_id: data.job_id, via: "get" };
            pingClientLog("consult_start_ok", "via=get job=" + data.job_id);
          } else {
            startData = { ok: false, detail: "Expert start-get returned no job_id" };
          }
        } else {
          let lastDetail = "Expert start-get failed (" + getResponse.status + ")";
          try {
            const errJson = await getResponse.json();
            lastDetail = errJson.error || errJson.detail || lastDetail;
          } catch (_error) {
            // keep
          }
          startData = { ok: false, detail: lastDetail };
          pingClientLog("consult_start_get_fail", lastDetail);
        }
      } catch (error) {
        startData = {
          ok: false,
          detail: (error && error.message) || "Failed to fetch",
        };
        pingClientLog("consult_start_get_net", startData.detail);
      }
    }

    // 3) POST append fallback (queued)
    if (!startData.ok) {
      startData = await enqueueHttp(async () => {
        let lastDetail = startData.detail || "Diagnostic request failed";
        const appendUrl = new URL(
          "/api/transcript/append",
          window.location.origin
        ).toString();
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            if (attempt > 1) {
              await delay(400 * attempt);
            }
            const startResponse = await fetchWithTimeout(
              appendUrl,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  transcript_id: tid || "none",
                  role: "TOOL_REQUEST",
                  event: "consult_helpdesk_expert",
                  text: JSON.stringify(argsOnly),
                }),
                cache: "no-store",
                credentials: "same-origin",
              },
              10000
            );
            if (!startResponse.ok) {
              try {
                const errJson = await startResponse.json();
                lastDetail = errJson.error || errJson.detail || lastDetail;
              } catch (_error) {
                lastDetail = "Expert start failed (" + startResponse.status + ")";
              }
              console.warn("[WARN] expert start via append", attempt, lastDetail);
              pushDebug("tool:start_fail:" + attempt);
              continue;
            }
            const data = await startResponse.json();
            if (!data.job_id) {
              lastDetail = "Expert start returned no job_id";
              continue;
            }
            pingClientLog("consult_start_ok", "via=append job=" + data.job_id);
            return { ok: true, job_id: data.job_id, via: "append" };
          } catch (error) {
            lastDetail = (error && error.message) || "Failed to fetch";
            console.warn("[WARN] expert start network", attempt, lastDetail);
            pushDebug("tool:start_net:" + attempt);
            pingClientLog(
              "consult_start_post_net",
              "attempt=" + attempt + " " + lastDetail
            );
          }
        }
        pingClientLog("consult_start_fail", lastDetail);
        return { ok: false, detail: lastDetail };
      });
    }

    if (!startData.ok) {
      consultHttpBusy = false;
      return startData;
    }

    if (typeof onStarted === "function") {
      try {
        onStarted();
      } catch (_error) {
        // ignore
      }
    }

    const jobId = startData.job_id;
    pushDebug("tool:job:" + jobId + ":" + (startData.via || "?"));
    console.log("[INFO] Expert job started", jobId, startData.via);

    const deadline = Date.now() + 90000;
    try {
      while (Date.now() < deadline) {
        await delay(700);
        // Prefer WS status polls; fall back to GET.
        try {
          if (controlWs && controlWs.readyState === WebSocket.OPEN) {
            const statusData = await wsRequest(
              "expert_status",
              { job_id: jobId },
              8000
            );
            if (statusData && statusData.status === "done") {
              pingClientLog("consult_done", "job=" + jobId + " via=ws");
              return {
                ok: true,
                data: {
                  ok: true,
                  model: statusData.model,
                  result: statusData.result,
                  cached_tokens: statusData.cached_tokens,
                },
              };
            }
            if (statusData && statusData.status === "error") {
              pingClientLog("consult_error", statusData.error || "job error");
              return {
                ok: false,
                detail: statusData.error || "Expert job failed",
              };
            }
            continue;
          }
        } catch (error) {
          console.warn("[WARN] expert status via WebSocket", error);
        }

        try {
          const statusUrl = new URL(
            "/api/transcript/expert/status/" + encodeURIComponent(jobId),
            window.location.origin
          ).toString();
          const statusResponse = await fetchWithTimeout(
            statusUrl,
            {
              method: "GET",
              cache: "no-store",
              credentials: "same-origin",
            },
            8000
          );
          if (!statusResponse.ok) {
            continue;
          }
          const statusData = await statusResponse.json();
          if (statusData.status === "done") {
            pingClientLog("consult_done", "job=" + jobId + " via=get");
            return {
              ok: true,
              data: {
                ok: true,
                model: statusData.model,
                result: statusData.result,
                cached_tokens: statusData.cached_tokens,
              },
            };
          }
          if (statusData.status === "error") {
            pingClientLog("consult_error", statusData.error || "job error");
            return {
              ok: false,
              detail: statusData.error || "Expert job failed",
            };
          }
        } catch (error) {
          console.warn("[WARN] expert status poll error", error);
        }
      }
      pingClientLog("consult_timeout", "job=" + jobId);
      return { ok: false, detail: "Expert consult timed out" };
    } finally {
      consultHttpBusy = false;
    }
  }

  function isCantoneseLanguage(value) {
    const text = String(value || "").toLowerCase();
    // Do not treat generic "Chinese" / "中文" / bare "zh" as Cantonese —
    // Mandarin callers often get those labels and must not be forced to 粤语.
    return (
      text.includes("cantonese") ||
      text.includes("粤") ||
      text.includes("粵") ||
      text.includes("廣東") ||
      text.includes("广东") ||
      text.includes("zh-hk") ||
      text.includes("zh_hk") ||
      text.includes("yue")
    );
  }

  function isMandarinLanguage(value) {
    const text = String(value || "").toLowerCase();
    return (
      text.includes("mandarin") ||
      text.includes("putonghua") ||
      text.includes("普通话") ||
      text.includes("普通話") ||
      text.includes("國語") ||
      text.includes("国语") ||
      text.includes("zh-cn") ||
      text.includes("zh_cn") ||
      text.includes("zh-hans")
    );
  }

  function isJapaneseLanguage(value) {
    const text = String(value || "").toLowerCase();
    return (
      text.includes("japanese") ||
      text.includes("日本語") ||
      text.includes("にほんご") ||
      text.includes("ja-jp") ||
      text.includes("ja_jp") ||
      text === "ja" ||
      text.startsWith("ja-") ||
      text.startsWith("ja_")
    );
  }

  function looksLikeTechCafePitch(value) {
    const text = String(value || "").toLowerCase();
    if (!text) {
      return false;
    }
    const mentionsTechCafe =
      text.includes("tech cafe") ||
      text.includes("techcafe") ||
      text.includes("面对面") ||
      text.includes("面對面");
    const offersBooking =
      text.includes("book") ||
      text.includes("appointment") ||
      text.includes("session") ||
      text.includes("预约") ||
      text.includes("預約") ||
      text.includes("予約");
    const recommends =
      text.includes("recommend") ||
      text.includes("suggest") ||
      text.includes("hands-on") ||
      text.includes("engineer") ||
      text.includes("would you like") ||
      text.includes("建议") ||
      text.includes("建議");
    return mentionsTechCafe && (offersBooking || recommends);
  }

  function looksLikeSlotOffer(value) {
    const text = String(value || "").toLowerCase();
    if (!text) {
      return false;
    }
    return (
      (text.includes("2:30") ||
        text.includes("2.30") ||
        text.includes("two thirty") ||
        text.includes("两点半") ||
        text.includes("兩點半") ||
        text.includes("午後2") ||
        text.includes("午後２")) &&
      (text.includes("book") ||
        text.includes("slot") ||
        text.includes("simulated") ||
        text.includes("预约") ||
        text.includes("預約") ||
        text.includes("予約"))
    );
  }

  function looksLikeBookingConfirmed(value) {
    const text = String(value || "").toLowerCase();
    if (!text) {
      return false;
    }
    return (
      (text.includes("booking") || text.includes("booked") || text.includes("reserved") ||
        text.includes("预留") || text.includes("預留") || text.includes("確保")) &&
      (text.includes("set") ||
        text.includes("confirmed") ||
        text.includes("done") ||
        text.includes("好了") ||
        text.includes("已经") ||
        text.includes("已經") ||
        text.includes("しました"))
    );
  }

  function updateBookingOfferStageFromTranscript(text) {
    if (looksLikeBookingConfirmed(text)) {
      bookingOfferStage = "booked";
      mergeTicketDraft({
        solution_summary:
          ticketDraft.solution_summary ||
          "Simulated Tech Cafe session booked (escalation; not resolved on call).",
        resolved: false,
      });
      return;
    }
    if (looksLikeSlotOffer(text)) {
      bookingOfferStage = "slot_offer";
      return;
    }
    if (looksLikeTechCafePitch(text)) {
      bookingOfferStage = "techcafe_pitch";
      mergeTicketDraft({
        solution_summary:
          ticketDraft.solution_summary ||
          "Recommended Tech Cafe session (escalation; not resolved on call).",
        resolved: false,
      });
    }
  }

  function clearBookingAdvanceState() {
    bookingAdvancePending = false;
    bookingAdvanceArmed = false;
    bookingAdvanceOwnResponseId = null;
    if (bookingAdvanceTimerId) {
      window.clearTimeout(bookingAdvanceTimerId);
      bookingAdvanceTimerId = null;
    }
  }

  function buildBookingAdvanceInstructions(strictRetry) {
    const voice = selectedVoice || "marin";
    if (bookingOfferStage === "slot_offer") {
      return (
        "The caller just replied after you offered the simulated 2:30 PM Tech Cafe slot. " +
        (strictRetry ? "IMPORTANT: do not re-ask about the slot. " : "") +
        "If their reply is acceptance (yes/please/okay/sure/book it), confirm the simulated booking in ONE short sentence " +
        "and ask if anything else is needed. Example: " +
        JSON.stringify(
          "Your simulated Tech Cafe booking for 2:30 PM is set. Anything else I can help you with?"
        ) +
        " If they declined, acknowledge and ask what they prefer instead. " +
        "Do NOT restate the Tech Cafe hardware pitch. Do NOT go back to charger/power troubleshooting. " +
        "Same session voice (" +
        voice +
        "). No tools. One reply only."
      );
    }
    return (
      "The caller just replied after you offered a Tech Cafe session / simulated booking. " +
      (strictRetry
        ? "CRITICAL: You already re-pitched Tech Cafe — do NOT do that again. "
        : "") +
      "If they clearly declined Tech Cafe, acknowledge briefly and ask what they prefer instead — do not offer a time slot. " +
      "Otherwise treat yes/please/okay/sure/book it/that's fine (and short affirmatives) as ACCEPTANCE. " +
      "On acceptance speak ONE short reply only: brief thanks, then offer the simulated time slot. Exact intent: " +
      JSON.stringify(
        "Great. The next simulated Tech Cafe slot I can offer is 2:30 PM. Would you like me to book that?"
      ) +
      " Do NOT repeat 'I recommend a Tech Cafe session' or ask again whether they want Tech Cafe. " +
      "Do NOT go back to charger/plug-in/power troubleshooting steps. " +
      "Same session voice (" +
      voice +
      "). No tools. One reply only."
    );
  }

  function maybeStartBookingAdvanceCoach() {
    if (
      pendingHangup ||
      isEnding ||
      diagnoseDeliveringResult ||
      diagnoseHoldInFlight ||
      bookingAdvancePending ||
      bookingOfferStage === "booked" ||
      bookingOfferStage === null
    ) {
      return;
    }
    if (bookingOfferStage !== "techcafe_pitch" && bookingOfferStage !== "slot_offer") {
      return;
    }
    if (!dataChannel || dataChannel.readyState !== "open") {
      return;
    }
    // Also accept when the latest transcript still looks like an offer.
    if (
      bookingOfferStage === "techcafe_pitch" &&
      !looksLikeTechCafePitch(lastAssistantTranscript) &&
      !looksLikeSlotOffer(lastAssistantTranscript)
    ) {
      // Stage can lag if barge-in cancelled before transcript.done; still coach.
    }
    runBookingAdvanceCoach().catch((error) => {
      console.warn("[WARN] Booking advance coach failed", error);
      clearBookingAdvanceState();
      enableLocalPlayback();
    });
  }

  async function runBookingAdvanceCoach() {
    bookingAdvancePending = true;
    bookingAdvanceArmed = false;
    bookingAdvanceOwnResponseId = null;
    pushDebug("booking:advance_start:" + bookingOfferStage);
    console.log("[INFO] Coaching booking advance after caller reply; stage=", bookingOfferStage);

    cancelActiveAssistantTurn("booking_advance_ready");
    silenceLocalPlayback();

    const killUntil = Date.now() + 900;
    while (Date.now() < killUntil) {
      if (assistantResponseActive || aiSpeaking) {
        cancelActiveAssistantTurn("booking_kill_auto");
        aiSpeaking = false;
        assistantResponseActive = false;
        silenceLocalPlayback();
      }
      await delay(80);
    }
    cancelActiveAssistantTurn("booking_before_speak");
    silenceLocalPlayback();
    await delay(150);

    if (!bookingAdvancePending || !dataChannel || dataChannel.readyState !== "open") {
      clearBookingAdvanceState();
      return;
    }
    if (userTurnActive) {
      // Caller started speaking again — abort coach.
      clearBookingAdvanceState();
      enableLocalPlayback();
      return;
    }

    bookingAdvanceArmed = true;
    sendAudioResponse({
      tool_choice: "none",
      instructions: buildBookingAdvanceInstructions(false),
    });
    setStatus("AI speaking...");
    pushDebug("booking:advance_speak");

    bookingAdvanceTimerId = window.setTimeout(() => {
      bookingAdvanceTimerId = null;
      if (bookingAdvancePending && !aiSpeaking) {
        console.warn("[WARN] Booking advance did not start; clearing gate");
        clearBookingAdvanceState();
        enableLocalPlayback();
      }
    }, 8000);
  }

  function looksLikeHoldLine(value) {
    const text = String(value || "").trim().toLowerCase();
    if (!text) {
      return false;
    }
    return (
      text.includes("still checking") ||
      text.includes("continue to hold") ||
      text.includes("please hold") ||
      text.includes("please continue to hold") ||
      text.includes("仲查緊") ||
      text.includes("再等一陣") ||
      text.includes("麻烦你再等") ||
      text.includes("麻煩你再等") ||
      text.includes("请稍等") ||
      text.includes("請稍等") ||
      text.includes("请继续等候") ||
      text.includes("請繼續等候") ||
      text.includes("还在查询") ||
      text.includes("還在查詢") ||
      text.includes("正在确认") ||
      text.includes("正在確認") ||
      text.includes("少々お待ち") ||
      text.includes("もう少々お待ち") ||
      text.includes("お待ちください") ||
      text.includes("確認中")
    );
  }

  function buildHoldLine(isFollowUp) {
    // Check Mandarin/Japanese before Cantonese so mixed labels do not misroute.
    if (isMandarinLanguage(diagnoseHoldLanguage)) {
      return isFollowUp
        ? "还在查询中，请继续稍等。"
        : "我正在确认，请稍等一下。";
    }
    if (isJapaneseLanguage(diagnoseHoldLanguage)) {
      return isFollowUp
        ? "まだ確認中です。もう少々お待ちください。"
        : "ただいま確認しております。少々お待ちください。";
    }
    if (isCantoneseLanguage(diagnoseHoldLanguage)) {
      return isFollowUp
        ? "仲查緊，麻煩你再等一陣。"
        : "我而家查緊，麻煩你等一陣。";
    }
    return isFollowUp
      ? "Still checking — please continue to hold."
      : "Please hold while I check this.";
  }

  function speakLocalHoldLine(line) {
    if (!window.speechSynthesis) {
      return;
    }
    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(line);
      if (isMandarinLanguage(diagnoseHoldLanguage)) {
        utterance.lang = "zh-CN";
      } else if (isJapaneseLanguage(diagnoseHoldLanguage)) {
        utterance.lang = "ja-JP";
      } else if (isCantoneseLanguage(diagnoseHoldLanguage)) {
        utterance.lang = "zh-HK";
      } else {
        utterance.lang = "en-US";
      }
      utterance.rate = 1.0;
      window.speechSynthesis.speak(utterance);
    } catch (error) {
      console.warn("[WARN] Local hold TTS failed", error);
    }
  }

  function appendTranscript(role, text, eventName) {
    if (!transcriptLoggingEnabled || !transcriptId) {
      return;
    }
    // Defer speech/transcript POSTs while consult HTTP is in flight (iPhone SSL).
    if (consultHttpBusy && eventName !== "diagnose_error") {
      return;
    }
    const body = {
      transcript_id: transcriptId,
      role: role,
      text: text || "",
      event: eventName || "",
    };
    // Queue behind other phone→Flask calls so we never race expert-start.
    enqueueHttp(async () => {
      try {
        await fetchWithTimeout(
          "/api/transcript/append",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            cache: "no-store",
            credentials: "same-origin",
          },
          8000
        );
      } catch (error) {
        console.warn("[WARN] transcript append failed", error);
      }
    });
  }

  async function startTranscriptSession(flagFromToken) {
    transcriptId = null;
    transcriptLoggingEnabled = false;
    const flagOn =
      flagFromToken === true ||
      flagFromToken === 1 ||
      flagFromToken === "true" ||
      flagFromToken === "1";
    // If token omitted the flag, still probe the start API (server is source of truth).
    if (flagFromToken === false || flagFromToken === 0 || flagFromToken === "false") {
      console.log("[INFO] Transcript logging off (token flag)");
      pushDebug("transcript:off");
      return;
    }
    try {
      const response = await fetch("/api/transcript/start", { method: "POST" });
      const data = await response.json();
      if (data && data.enabled && data.transcript_id) {
        transcriptLoggingEnabled = true;
        transcriptId = data.transcript_id;
        if (data.call_id) {
          sessionCallId = String(data.call_id);
        } else if (!sessionCallId) {
          sessionCallId = transcriptId;
        }
        console.log("[INFO] Transcript logging to", transcriptId);
        pushDebug("transcript:" + transcriptId);
      } else if (data && data.enabled === false) {
        if (data.call_id && !sessionCallId) {
          sessionCallId = String(data.call_id);
        }
        console.log("[INFO] Transcript logging disabled by server");
        pushDebug("transcript:off");
      } else {
        console.warn("[WARN] Transcript start unexpected response", data);
        pushDebug("transcript:bad_response");
      }
    } catch (error) {
      console.warn("[WARN] transcript start failed", error);
      pushDebug("transcript:error");
      transcriptLoggingEnabled = false;
      transcriptId = null;
    }
    if (!flagOn && transcriptLoggingEnabled) {
      // Token did not advertise logging, but server enabled it.
      pushDebug("transcript:server_enabled");
    }
  }

  function noteSpelledNameFromAssistantSpeech(speechText) {
    if (!speechText) {
      return;
    }
    // Only letter-by-letter: "spelled C A L V I N" / "spelling C-A-L-V-I-N".
    // Do NOT match phrases like "spelling you provided" (call-20260916-170710-b05f).
    // Do NOT pull the leading letter of the surname (call-20260916-171047-e98d:
    // "spelled C A L V I N, Chen" must not become Calvinc).
    const Match = String(speechText).match(
      /(?:spell(?:ed|ing)?)\s*(?:as|is|:|,)?\s*([A-Za-z](?:(?:\s*[,\-]+\s*|\s+)[A-Za-z]){1,24})(?![A-Za-z])/i
    );
    if (!Match) {
      return;
    }
    const Tokens = Match[1].split(/[\s,\-]+/).filter(Boolean);
    if (
      Tokens.length < 2 ||
      Tokens.length > 24 ||
      !Tokens.every(function (Token) {
        return /^[A-Za-z]$/.test(Token);
      })
    ) {
      return;
    }
    const Letters = Tokens.join("");
    const Spelled =
      Letters.charAt(0).toUpperCase() + Letters.slice(1).toLowerCase();
    spelledCallerName = Spelled;
    const Current = (ticketDraft.caller_name || "").trim();
    if (!Current) {
      ticketDraft.caller_name = Spelled;
    } else {
      const Parts = Current.split(/\s+/);
      if (Parts[0].toLowerCase() !== Spelled.toLowerCase()) {
        Parts[0] = Spelled;
        ticketDraft.caller_name = Parts.join(" ");
      }
    }
    pushDebug("ticket:name_spelling=" + ticketDraft.caller_name);
    console.log(
      "[INFO] Name spelling correction from speech:",
      ticketDraft.caller_name
    );
  }

  function resolveCallerNameForTicket(parsedName) {
    const FromTool = parsedName ? String(parsedName).trim() : "";
    if (spelledCallerName) {
      if (FromTool) {
        const Parts = FromTool.split(/\s+/);
        if (Parts[0].toLowerCase() !== spelledCallerName.toLowerCase()) {
          Parts[0] = spelledCallerName;
          return Parts.join(" ");
        }
        return FromTool;
      }
      return (ticketDraft.caller_name || spelledCallerName).trim();
    }
    return FromTool || (ticketDraft.caller_name || "").trim();
  }

  function mergeTicketDraft(partial) {
    if (!partial || typeof partial !== "object") {
      return;
    }
    if (partial.caller_name) {
      const Incoming = String(partial.caller_name).trim();
      // Prefer letter-spelling correction over a later misheard tool arg.
      if (spelledCallerName) {
        const Parts = Incoming.split(/\s+/);
        if (Parts[0].toLowerCase() !== spelledCallerName.toLowerCase()) {
          Parts[0] = spelledCallerName;
          ticketDraft.caller_name = Parts.join(" ");
        } else {
          ticketDraft.caller_name = Incoming;
        }
      } else {
        ticketDraft.caller_name = Incoming;
      }
    }
    if (partial.problem_summary) {
      ticketDraft.problem_summary = String(partial.problem_summary).trim();
    }
    if (partial.solution_summary) {
      ticketDraft.solution_summary = String(partial.solution_summary).trim();
    }
    if (partial.resolved === true || partial.resolved === false) {
      ticketDraft.resolved = partial.resolved;
    } else if (typeof partial.resolved === "string") {
      const lowered = partial.resolved.trim().toLowerCase();
      if (lowered === "true" || lowered === "false") {
        ticketDraft.resolved = lowered === "true";
      }
    }
  }

  function buildTicketFieldsFromEndCall(parsed, reason) {
    const fields = {
      caller_name: ticketDraft.caller_name || "",
      problem_summary: ticketDraft.problem_summary || "",
      solution_summary: ticketDraft.solution_summary || "",
      resolved: ticketDraft.resolved,
    };
    if (parsed && typeof parsed === "object") {
      fields.caller_name = resolveCallerNameForTicket(parsed.caller_name);
      if (parsed.problem_summary) {
        fields.problem_summary = String(parsed.problem_summary).trim();
      }
      if (parsed.solution_summary) {
        fields.solution_summary = String(parsed.solution_summary).trim();
      }
      if (parsed.resolved === true || parsed.resolved === false) {
        fields.resolved = parsed.resolved;
      } else if (typeof parsed.resolved === "string") {
        const lowered = parsed.resolved.trim().toLowerCase();
        if (lowered === "true" || lowered === "false") {
          fields.resolved = lowered === "true";
        }
      }
    } else if (spelledCallerName) {
      fields.caller_name = resolveCallerNameForTicket(fields.caller_name);
    }
    // Model often dumps the whole close into reason and skips structured fields.
    if (!fields.solution_summary && reason && reason !== "done") {
      fields.solution_summary = String(reason).trim();
    }
    if (!fields.problem_summary && reason) {
      fields.problem_summary = String(reason);
    }
    const blob = (
      (fields.solution_summary || "") +
      " " +
      (reason || "") +
      " " +
      (fields.problem_summary || "")
    ).toLowerCase();
    if (fields.resolved == null) {
      if (
        blob.includes("servicenow") ||
        blob.includes("tech cafe") ||
        blob.includes("escalat") ||
        blob.includes("not resolved") ||
        blob.includes("booking")
      ) {
        fields.resolved = false;
      } else if (
        blob.includes("resolved") ||
        blob.includes("fixed") ||
        blob.includes("working again")
      ) {
        fields.resolved = true;
      }
    }
    if (fields.resolved !== true && fields.resolved !== false) {
      fields.resolved = false;
    }
    if (!fields.caller_name) {
      fields.caller_name = "unknown";
    }
    return fields;
  }

  function submitCallTicket(fields, finalize) {
    const id = sessionCallId || transcriptId;
    if (!id) {
      return;
    }
    const body = {
      call_id: id,
      transcript_id: transcriptId || id,
      finalize: !!finalize,
      ...(fields || {}),
    };
    fetch("/api/ticket", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
    })
      .then((response) => response.json().catch(() => ({})))
      .then((data) => {
        if (data && data.ticket_file) {
          console.log("[INFO] Ticket CSV", data.ticket_file);
          pushDebug("ticket:" + data.ticket_file);
        }
      })
      .catch((error) => {
        console.warn("[WARN] ticket submit failed", error);
      });
  }

  function endTranscriptSession() {
    const id = transcriptId;
    const sid = sessionCallId || transcriptId;
    const ticketPayload = pendingTicketFields || {};
    transcriptId = null;
    sessionCallId = null;
    pendingTicketFields = null;
    if (sid) {
      // Always finalize a ticket CSV when the call ends (server fills times).
      fetch("/api/ticket", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          call_id: sid,
          transcript_id: id || sid,
          finalize: true,
          ...ticketPayload,
        }),
        keepalive: true,
      }).catch((error) => {
        console.warn("[WARN] ticket finalize failed", error);
      });
    }
    if (!id) {
      return;
    }
    fetch("/api/transcript/end", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transcript_id: id,
        call_id: sid || id,
        ...ticketPayload,
      }),
      keepalive: true,
    }).catch((error) => {
      console.warn("[WARN] transcript end failed", error);
    });
  }

  async function sendToolOutput(callId, output, createResponse) {
    if (!dataChannel || dataChannel.readyState !== "open") {
      return;
    }
    // Always acknowledge the tool call to the server, but never start a fresh
    // spoken response while the caller is still talking after a barge-in.
    const shouldCreateResponse =
      createResponse !== false && !userTurnActive && !bargeInInProgress;
    dataChannel.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify(output),
        },
      })
    );
    if (!shouldCreateResponse) {
      if (createResponse !== false && (userTurnActive || bargeInInProgress)) {
        pushDebug("tool:output_no_speak");
      }
      return;
    }
    sendAudioResponse({ output_modalities: ["audio"] });
    setStatus("AI speaking...");
  }

  function speechLooksLikeFarewell(text) {
    return FAREWELL_SPEECH_RE.test(String(text || ""));
  }

  function speechLooksLikeClosingFarewell(text) {
    const Value = String(text || "").trim();
    if (!Value || !speechLooksLikeFarewell(Value)) {
      return false;
    }
    // Closing goodbye (not a mid-call "have a good day" aside).
    if (CLOSING_FAREWELL_RE.test(Value)) {
      return true;
    }
    if (/\bgoodbye\b/i.test(Value) && Value.length <= 180) {
      return true;
    }
    if (
      /(再見|再见|さようなら|失礼します|失礼いたします|拜拜)/.test(Value) &&
      Value.length <= 200
    ) {
      return true;
    }
    return false;
  }

  function maybeScheduleHangupFromFarewellSpeech(text) {
    if (pendingHangup || isEnding || !callAudioReady) {
      return;
    }
    if (!speechLooksLikeClosingFarewell(text)) {
      return;
    }
    console.log(
      "[INFO] Closing farewell heard without end_call; scheduling hangup"
    );
    pushDebug("hangup:from_farewell_speech");
    appendTranscript(
      "SYSTEM",
      "Closing farewell detected; ending call (end_call tool was not used)",
      "hangup_from_speech"
    );
    scheduleHangup("farewell_speech_without_tool");
  }

  function maybeCompleteHangupSpeechCheck() {
    if (!pendingHangup || !hangupAwaitingSpeechCheck || isEnding) {
      return;
    }
    if (aiSpeaking) {
      return;
    }
    hangupAwaitingSpeechCheck = false;
    if (speechLooksLikeFarewell(lastAssistantTranscript)) {
      hangupAudioHeard = true;
      pushDebug("hangup:confirmed_farewell");
      if (hangupGraceTimerId) {
        window.clearTimeout(hangupGraceTimerId);
      }
      hangupGraceTimerId = window.setTimeout(() => finishHangup(), 1200);
      return;
    }
    // e.g. "I'll close this out and end the call now" — not a real goodbye
    pushDebug("hangup:need_real_goodbye");
    console.log(
      "[INFO] end_call speech was not a farewell; requesting goodbye:",
      lastAssistantTranscript.slice(0, 80)
    );
    hangupAudioHeard = false;
    requestGoodbyeBeforeHangup();
  }

  function requestGoodbyeBeforeHangup() {
    if (!pendingHangup || hangupGoodbyeRequested || isEnding) {
      return;
    }
    if (!dataChannel || dataChannel.readyState !== "open") {
      finishHangup();
      return;
    }
    hangupGoodbyeRequested = true;
    hangupAwaitingSpeechCheck = false;
    setStatus("Saying goodbye...");
    pushDebug("hangup:request_goodbye");
    console.log("[INFO] Requesting goodbye audio before hangup");
    try {
      sendAudioResponse({
        tool_choice: "none",
        instructions:
          "The call is ending now. Speak a warm, complete closing goodbye in the caller's language. " +
          "Use the same session voice as the rest of this call — do not switch voice or accent. " +
          "Thank them for calling Tech Cafe IT Help Desk, wish them a good day, and you MUST end with " +
          "an explicit farewell word: say 'Goodbye' in English, 'さようなら' or '失礼いたします' in Japanese, '再见' in Mandarin, or '再見' in Cantonese. " +
          "Do not say only that you will end the call. Do not ask questions. Do not call any tools. " +
          "Keep it to 1-2 short sentences.",
      });
    } catch (error) {
      console.warn("[WARN] Could not request goodbye audio", error);
      finishHangup();
    }
  }

  function scheduleHangup(reason) {
    if (pendingHangup || isEnding) {
      return;
    }
    pendingHangup = true;
    hangupGoodbyeRequested = false;
    hangupAudioHeard = false;
    hangupAwaitingSpeechCheck = false;
    setStatus("Saying goodbye...");
    pushDebug("hangup:" + reason);
    console.log("[INFO] Auto hangup scheduled; requiring goodbye audio:", reason);

    // Only reuse speech that is actually a farewell (Goodbye/再見/…).
    // "I'll close this out and end the call now" must NOT count
    // (call-20260912-210404-4584).
    const recentFarewell =
      speechLooksLikeFarewell(lastAssistantTranscript) &&
      lastAssistantAudioStoppedAt != null &&
      Date.now() - lastAssistantAudioStoppedAt < HANGUP_RECENT_GOODBYE_MS;

    if (aiSpeaking) {
      // Wait for current utterance + transcript, then confirm farewell or request one.
      hangupAwaitingSpeechCheck = true;
      pushDebug("hangup:wait_speech_check");
    } else if (recentFarewell) {
      hangupAudioHeard = true;
      pushDebug("hangup:reuse_recent_goodbye");
      if (hangupGraceTimerId) {
        window.clearTimeout(hangupGraceTimerId);
      }
      hangupGraceTimerId = window.setTimeout(() => finishHangup(), 1200);
    } else {
      window.setTimeout(() => {
        if (pendingHangup && !hangupAudioHeard && !hangupGoodbyeRequested) {
          requestGoodbyeBeforeHangup();
        }
      }, 300);
    }

    if (hangupTimerId) {
      window.clearTimeout(hangupTimerId);
    }
    hangupTimerId = window.setTimeout(() => {
      console.warn("[WARN] Hangup fallback timer fired");
      finishHangup();
    }, 15000);
  }

  function finishHangup() {
    if (hangupTimerId) {
      window.clearTimeout(hangupTimerId);
      hangupTimerId = null;
    }
    if (hangupGraceTimerId) {
      window.clearTimeout(hangupGraceTimerId);
      hangupGraceTimerId = null;
    }
    if (!pendingHangup) {
      return;
    }
    pendingHangup = false;
    hangupAudioHeard = false;
    hangupGoodbyeRequested = false;
    hangupAwaitingSpeechCheck = false;
    setStatus("Call ended");
    cleanupCall(true);
  }

  function wireMicTrackEvents(track) {
    if (!track) {
      return;
    }
    track.onended = () => {
      console.warn("[WARN] Mic track ended");
      pushDebug("mic:ended");
      recoverMicrophone("track_ended").catch((error) => {
        console.warn("[WARN] recover after ended failed", error);
      });
    };
    track.onmute = () => {
      console.warn("[WARN] Mic track muted");
      pushDebug("mic:muted");
    };
    track.onunmute = () => {
      console.log("[INFO] Mic track unmuted");
      pushDebug("mic:unmuted");
    };
  }

  async function ensureLiveMicOnSender(reason) {
    if (!peerConnection || isEnding) {
      return;
    }
    let track = localStream && localStream.getAudioTracks()[0];
    if (!track || track.readyState !== "live") {
      await recoverMicrophone(reason || "ensure_live");
      track = localStream && localStream.getAudioTracks()[0];
    }
    if (!track) {
      return;
    }
    track.enabled = !greetingMicHeld;
    wireMicTrackEvents(track);

    const sender =
      audioSender ||
      peerConnection.getSenders().find((item) => !item.track || item.track.kind === "audio");
    if (sender) {
      audioSender = sender;
      if (sender.track !== track) {
        await sender.replaceTrack(track);
        console.log("[INFO] Mic re-attached to sender (" + reason + "):", track.label);
        pushDebug("mic:reattach");
      }
    }
  }

  async function recoverMicrophone(reason) {
    if (micRecovering || isEnding || !peerConnection) {
      return;
    }
    // Greeting intentionally disables the local track (silent uplink / 0% meter).
    // Recovering then causes dead_uplink loops and can block ICE + Hello audio.
    const duringGreeting = greetingMicHeld || !callAudioReady;
    if (
      duringGreeting &&
      reason !== "track_ended" &&
      reason !== "dead_track"
    ) {
      console.log("[INFO] Skip mic recover during greeting hold:", reason);
      pushDebug("mic:skip_recover:" + reason);
      return;
    }
    micRecovering = true;
    try {
      console.log("[INFO] Recovering default microphone:", reason);
      pushDebug("mic:recover:" + reason);
      setStatus("Reconnecting microphone...");

      const fresh = await acquireDefaultMicrophone();
      localStream = fresh;
      const track = fresh.getAudioTracks()[0];
      if (!track) {
        throw new Error("No mic track during recovery");
      }
      track.enabled = !greetingMicHeld;
      wireMicTrackEvents(track);
      startMicMeter(fresh);

      if (audioSender) {
        await audioSender.replaceTrack(track);
      } else {
        audioSender = peerConnection.addTrack(track, fresh);
      }

      zeroUplinkSeconds = 0;
      setStatus("Listening...");
      console.log("[INFO] Microphone recovered:", track.label || "system default");
    } finally {
      micRecovering = false;
    }
  }

  function startMicMeter(stream) {
    try {
      if (meterContext) {
        meterContext.close().catch(() => {});
        meterContext = null;
      }
      meterContext = new (window.AudioContext || window.webkitAudioContext)();
      const source = meterContext.createMediaStreamSource(stream);
      const analyser = meterContext.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);

      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i += 1) {
          const centered = (data[i] - 128) / 128;
          sum += centered * centered;
        }
        const rms = Math.sqrt(sum / data.length);
        lastMicPct = Math.min(100, Math.round(rms * 500));
        meterBar.style.width = lastMicPct + "%";
        meterAnimId = window.requestAnimationFrame(tick);
      };
      if (meterAnimId) {
        window.cancelAnimationFrame(meterAnimId);
      }
      meterAnimId = window.requestAnimationFrame(tick);
      meterContext.resume().catch(() => {});
    } catch (error) {
      console.warn("[WARN] Mic meter unavailable", error);
    }
  }

  function stopMicMeter() {
    if (meterAnimId) {
      window.cancelAnimationFrame(meterAnimId);
      meterAnimId = null;
    }
    if (meterContext) {
      meterContext.close().catch(() => {});
      meterContext = null;
    }
    meterBar.style.width = "0%";
  }

  function startOutboundStats() {
    stopOutboundStats();
    statsTimerId = window.setInterval(async () => {
      if (!peerConnection) {
        return;
      }
      try {
        const stats = await peerConnection.getStats();
        let bytesSent = 0;
        let packetsSent = 0;
        stats.forEach((report) => {
          if (report.type === "outbound-rtp" && (!report.kind || report.kind === "audio")) {
            bytesSent = report.bytesSent || 0;
            packetsSent = report.packetsSent || 0;
          }
        });
        const delta = bytesSent - lastBytesSent;
        lastBytesSent = bytesSent;
        const track = localStream && localStream.getAudioTracks()[0];
        const trackDead = !track || track.readyState !== "live";
        const silentMic = lastMicPct < 2;
        pushDebug(
          "mic%" +
            lastMicPct +
            " up+" +
            delta +
            "b pkt=" +
            packetsSent +
            (trackDead ? " DEAD" : " live") +
            (silentMic ? " SILENT-MIC" : "")
        );

        // Ignore intentional silence while greeting mic is held / call not ready.
        if (greetingMicHeld || !callAudioReady) {
          zeroUplinkSeconds = 0;
        } else if (trackDead || (silentMic && delta === 0)) {
          zeroUplinkSeconds += 1;
        } else {
          zeroUplinkSeconds = 0;
        }

        if (zeroUplinkSeconds >= 3 && !micRecovering && !isEnding) {
          zeroUplinkSeconds = 0;
          recoverMicrophone(trackDead ? "dead_track" : "dead_uplink").catch((error) => {
            console.warn("[WARN] uplink recover failed", error);
          });
        }
      } catch (error) {
        console.warn("[WARN] getStats failed", error);
      }
    }, 1000);
  }

  function stopOutboundStats() {
    if (statsTimerId) {
      window.clearInterval(statsTimerId);
      statsTimerId = null;
    }
  }

  function waitForIceGatheringComplete(pc) {
    if (pc.iceGatheringState === "complete") {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) {
          return;
        }
        settled = true;
        pc.removeEventListener("icegatheringstatechange", onChange);
        resolve();
      };
      const onChange = () => {
        if (pc.iceGatheringState === "complete") {
          done();
        }
      };
      pc.addEventListener("icegatheringstatechange", onChange);
      window.setTimeout(done, 2500);
    });
  }

  function endCall() {
    setStatus("Call ended");
    cleanupCall(true);
  }

  function cleanupCall(resetReady) {
    if (isEnding) {
      return;
    }
    isEnding = true;
    isConnecting = false;
    greetingSent = false;
    greetingResponseId = null;
    greetingAudioStarted = false;
    greetingMicHeld = false;
    clearGreetingReadyTimer();
    clearGreetingGraceTimer();
    callAudioReady = false;
    pendingHangup = false;
    attachedRemoteStream = null;
    remotePlaybackMode = "element";
    preferredOutputSinkId = "default";
    stopConnectingTone();
    stopOutputAudioContext();
    hangupAudioHeard = false;
    hangupGoodbyeRequested = false;
    hangupAwaitingSpeechCheck = false;
    lastAssistantAudioStoppedAt = null;
    lastAssistantTranscript = "";
    stopDiagnoseHoldPrompts(false);
    bookingOfferStage = null;
    clearBookingAdvanceState();
    closeControlSocket();
    endTranscriptSession();
    aiSpeaking = false;
    assistantResponseActive = false;
    currentAssistantItemId = null;
    assistantPlayStartedAt = null;
    bargeInInProgress = false;
    userTurnActive = false;
    assistantRepliesThisUserTurn = 0;
    activeResponseId = null;
    cancelledResponseIds.clear();
    if (hangupTimerId) {
      window.clearTimeout(hangupTimerId);
      hangupTimerId = null;
    }
    if (hangupGraceTimerId) {
      window.clearTimeout(hangupGraceTimerId);
      hangupGraceTimerId = null;
    }
    audioSender = null;
    stopTimer();
    stopOutboundStats();

    if (dataChannel) {
      try {
        dataChannel.close();
      } catch (_error) {
        // ignore
      }
      dataChannel = null;
    }

    if (peerConnection) {
      try {
        peerConnection.close();
      } catch (_error) {
        // ignore
      }
      peerConnection = null;
    }

    if (remoteAudio) {
      try {
        remoteAudio.pause();
        remoteAudio.srcObject = null;
        remoteAudio.remove();
      } catch (_error) {
        // ignore
      }
      remoteAudio = null;
    }

    startBtn.classList.remove("hidden");
    startBtn.disabled = false;
    if (devicePickers) {
      devicePickers.classList.remove("hidden");
    }
    setDevicePickersEnabled(true);
    refreshDeviceLists().catch(() => {});
    endBtn.classList.add("hidden");
    timerEl.classList.add("hidden");
    debugEl.classList.add("hidden");
    timerEl.textContent = "00:00";
    debugEl.textContent = "";

    // Release mic when idle — do not keep capturing for a pre-call level meter.
    releaseMicrophone();

    if (resetReady) {
      window.setTimeout(() => {
        setStatus("Ready — tap the button to start (uses mic + speakers)");
        isEnding = false;
      }, 500);
    } else {
      isEnding = false;
    }
  }

  function startTimer() {
    callStartedAt = Date.now();
    timerEl.textContent = "00:00";
    callTimerId = window.setInterval(() => {
      const elapsed = Math.floor((Date.now() - callStartedAt) / 1000);
      const minutes = String(Math.floor(elapsed / 60)).padStart(2, "0");
      const seconds = String(elapsed % 60).padStart(2, "0");
      timerEl.textContent = `${minutes}:${seconds}`;
    }, 1000);
  }

  function stopTimer() {
    if (callTimerId) {
      window.clearInterval(callTimerId);
      callTimerId = null;
    }
    callStartedAt = null;
  }

  function unlockOutputAudioFromUserGesture() {
    // Must run synchronously from the Start button click (Chrome/Edge autoplay policy).
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        if (!outputAudioContext || outputAudioContext.state === "closed") {
          outputAudioContext = new AudioCtx();
        }
        if (outputAudioContext.state === "suspended") {
          outputAudioContext.resume().catch(() => {});
        }
        // Prime the graph so later MediaStreamSource is audible.
        const priming = outputAudioContext.createGain();
        priming.gain.value = 0.0001;
        priming.connect(outputAudioContext.destination);
        const osc = outputAudioContext.createOscillator();
        osc.frequency.value = 440;
        osc.connect(priming);
        const t0 = outputAudioContext.currentTime;
        osc.start(t0);
        osc.stop(t0 + 0.05);
      }

      if (!remoteAudio) {
        remoteAudio = document.createElement("audio");
        remoteAudio.autoplay = true;
        remoteAudio.preload = "auto";
        remoteAudio.setAttribute("playsinline", "true");
        document.body.appendChild(remoteAudio);
      }
      remoteAudio.muted = false;
      remoteAudio.volume = 1.0;
      // Do not tear down the element after unlock — Chrome may revoke media engagement.
      const silentUrl = buildSilentWavUrl();
      remoteAudio.src = silentUrl;
      remoteAudio.play().catch((error) => {
        console.warn("[WARN] Output unlock play failed", error);
      });
      pushDebug(
        "audio:unlock:ctx=" +
          (outputAudioContext ? outputAudioContext.state : "none")
      );
      console.log(
        "[INFO] Output audio unlocked; AudioContext state=",
        outputAudioContext ? outputAudioContext.state : "none"
      );
    } catch (error) {
      console.warn("[WARN] Output unlock failed", error);
    }
  }

  function buildSilentWavUrl() {
    const sampleRate = 22050;
    const sampleCount = Math.floor(sampleRate * 0.05);
    const dataSize = sampleCount * 2;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    function writeAscii(offset, text) {
      for (let i = 0; i < text.length; i += 1) {
        view.setUint8(offset + i, text.charCodeAt(i));
      }
    }
    writeAscii(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeAscii(8, "WAVE");
    writeAscii(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeAscii(36, "data");
    view.setUint32(40, dataSize, true);
    const blob = new Blob([buffer], { type: "audio/wav" });
    return URL.createObjectURL(blob);
  }

  function startConnectingTone() {
    stopConnectingTone();
    connectingToneActive = true;
    setStatus("Connecting — ringing...");
    pushDebug("ring:start");
    try {
      // Prefer HTMLAudio on the same OS-selected sink as remote AI audio.
      // Matching the active mic's output group fixes BT HFP (ring was on speakers).
      connectingToneUrl = buildConnectingRingWavUrl();
      connectingToneAudio = new Audio(connectingToneUrl);
      connectingToneAudio.preload = "auto";
      connectingToneAudio.volume = 0.8;
      const beginRing = () => {
        if (!connectingToneActive) {
          return;
        }
        playConnectingRingBurst();
        connectingToneTimerId = window.setInterval(() => {
          if (!connectingToneActive) {
            return;
          }
          playConnectingRingBurst();
        }, CONNECTING_RING_CYCLE_MS);
      };
      const bindAndRing = async () => {
        await resolvePreferredOutputSinkId();
        await setElementOutputSink(connectingToneAudio);
      };
      bindAndRing()
        .catch(() => {})
        .finally(beginRing);
    } catch (error) {
      console.warn("[WARN] Connecting ring setup failed", error);
    }
  }

  function stopConnectingTone() {
    connectingToneActive = false;
    if (connectingToneTimerId) {
      window.clearInterval(connectingToneTimerId);
      connectingToneTimerId = null;
    }
    killConnectingToneNodes();
    if (connectingToneAudio) {
      try {
        connectingToneAudio.pause();
        connectingToneAudio.volume = 0;
        connectingToneAudio.removeAttribute("src");
        connectingToneAudio.load();
      } catch (_error) {
        // ignore
      }
      connectingToneAudio = null;
    }
    if (connectingToneUrl) {
      try {
        URL.revokeObjectURL(connectingToneUrl);
      } catch (_error) {
        // ignore
      }
      connectingToneUrl = null;
    }
  }

  function killConnectingToneNodes() {
    // Web Audio oscillators keep playing until scheduled stop unless muted/stopped.
    const ctx = outputAudioContext;
    const now = ctx && ctx.state !== "closed" ? ctx.currentTime : 0;
    if (connectingToneGain) {
      try {
        connectingToneGain.gain.cancelScheduledValues(now);
        connectingToneGain.gain.setValueAtTime(0, now);
        connectingToneGain.disconnect();
      } catch (_error) {
        // ignore
      }
      connectingToneGain = null;
    }
    connectingToneOscillators.forEach((osc) => {
      try {
        osc.stop(now);
      } catch (_error) {
        // already stopped
      }
      try {
        osc.disconnect();
      } catch (_error) {
        // ignore
      }
    });
    connectingToneOscillators = [];
  }

  function playConnectingRingBurst() {
    if (!connectingToneActive) {
      return;
    }
    try {
      if (connectingToneAudio) {
        connectingToneAudio.pause();
        connectingToneAudio.currentTime = 0;
        connectingToneAudio.volume = 0.8;
        connectingToneAudio.play().catch((error) => {
          console.warn("[WARN] Connecting ring play failed", error);
          // Fallback to AudioContext if HTMLAudio is blocked.
          if (outputAudioContext && outputAudioContext.state !== "closed") {
            ensureOutputAudioContextRunning();
            playConnectingRingback(
              outputAudioContext,
              outputAudioContext.currentTime
            );
          }
        });
        return;
      }
      if (outputAudioContext && outputAudioContext.state !== "closed") {
        ensureOutputAudioContextRunning();
        playConnectingRingback(outputAudioContext, outputAudioContext.currentTime);
      }
    } catch (error) {
      console.warn("[WARN] Connecting ring failed", error);
    }
  }

  function playConnectingRingback(ctx, startAt) {
    // Classic phone ringback: steady dual-tone (not a short beep / ding).
    killConnectingToneNodes();
    const duration = CONNECTING_RING_ON_SEC;
    const master = ctx.createGain();
    master.gain.setValueAtTime(0.0001, startAt);
    master.gain.linearRampToValueAtTime(0.2, startAt + 0.02);
    master.gain.setValueAtTime(0.2, startAt + duration - 0.04);
    master.gain.linearRampToValueAtTime(0.0001, startAt + duration);
    master.connect(ctx.destination);
    connectingToneGain = master;
    connectingToneOscillators = [];
    [440, 480].forEach((freq) => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, startAt);
      osc.connect(master);
      osc.start(startAt);
      osc.stop(startAt + duration + 0.02);
      connectingToneOscillators.push(osc);
    });
  }

  function buildConnectingRingWavUrl() {
    // ~2s North American ringback WAV (440+480 Hz); timer adds the 4s quiet.
    const sampleRate = 44100;
    const totalSec = CONNECTING_RING_ON_SEC;
    const sampleCount = Math.floor(sampleRate * totalSec);
    const dataSize = sampleCount * 2;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    function writeAscii(offset, text) {
      for (let i = 0; i < text.length; i += 1) {
        view.setUint8(offset + i, text.charCodeAt(i));
      }
    }

    writeAscii(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeAscii(8, "WAVE");
    writeAscii(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeAscii(36, "data");
    view.setUint32(40, dataSize, true);

    for (let i = 0; i < sampleCount; i += 1) {
      const t = i / sampleRate;
      const fadeIn = Math.min(1, t / 0.02);
      const fadeOut = Math.min(1, (totalSec - t) / 0.04);
      const envelope = fadeIn * fadeOut;
      const amp =
        0.22 *
        envelope *
        (Math.sin(2 * Math.PI * 440 * t) + Math.sin(2 * Math.PI * 480 * t));
      const sample = Math.max(-1, Math.min(1, amp));
      view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    }

    const blob = new Blob([buffer], { type: "audio/wav" });
    return URL.createObjectURL(blob);
  }

  function setStatus(text) {
    statusEl.textContent = text;
  }

  function pushDebug(text) {
    recentEvents.push(text);
    while (recentEvents.length > 6) {
      recentEvents.shift();
    }
    debugEl.textContent = recentEvents.join(" · ");
  }
})();
