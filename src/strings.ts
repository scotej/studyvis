// Single source of truth for user-facing copy. V3-P8 (DESIGN-SYSTEM §14).
//
// Voice rules — short, direct, second person, no hype, no emoji-cheer.
// Periods on full sentences; none on labels and button text. "Couldn't",
// not "Could not". Specific over generic.
//
// This is a single-locale module, not i18n. The goal is one place to find
// (and proofread) every word the user reads. JSX-laden strings live in
// their components as small fragments around a `<Kbd>` or an inline link;
// their text-only halves still live here.
//
// Coverage exceptions, by design:
//   - Tray menu items live in src-tauri/src/lib.rs (the Rust binary owns
//     the native menu; they can't be hot-pulled from JS).
//   - Storybook stories and the dev-only `/style` route inline their own
//     demo wording so the previews are self-contained.
//   - Model-catalogue data (display name, blurb, license) lives in
//     features/ai/models.ts — that's metadata, not UI copy.
//
// New strings: add them here, then reference. scripts/check-strings.ts
// guards against raw literals slipping back into components.

import type { AuditEventKind } from '@/lib/audit-types'

const ELLIPSIS = '…'

export const strings = {
  app: {
    name: 'StudyVis',
    homeSrHeading: 'StudyVis',
    sessionSrHeading: 'Studying with friends',
    error: {
      title: 'Something went wrong',
      body: 'A part of StudyVis ran into an unexpected error. Your identity, friends, and history are safe.',
      retry: 'Try again',
    },
  },

  common: {
    loading: `Loading${ELLIPSIS}`,
    actions: {
      continue: 'Continue',
      cancel: 'Cancel',
      back: 'Back',
      close: 'Close',
      save: 'Save',
      retry: 'Retry',
      remove: 'Remove',
      open: 'Open',
      copy: 'Copy',
      copied: 'Copied',
      gotIt: 'Got it',
      tryAgain: 'Try again',
      skipForNow: 'Skip for now',
      notNow: 'Not now',
      forget: 'Forget',
      reset: 'Reset',
      restart: 'Restart',
    },
    errors: {
      copyToClipboard: "Couldn't copy to clipboard.",
      savingIdentity: "Couldn't save your identity.",
    },
    time: {
      justNow: 'just now',
      secondsAgo: (n: number) => `${n}s ago`,
      minutesAgo: (n: number) => `${n}m ago`,
      hoursAgo: (n: number) => `${n}h ago`,
    },
  },

  onboarding: {
    welcome: {
      ariaLabel: 'Welcome',
      cta: 'Set up StudyVis',
      heading: "Let's set you up.",
      body: 'StudyVis is a quiet place to study with friends. No account, no server, no audience. Just you, your friends, and the work.',
    },
    identityChoice: {
      ariaLabel: 'Set up your identity',
      heading: 'Set up your identity',
      body: 'New to StudyVis, or moving to a new device? Either way, no account and no server.',
      createCta: 'Create a new identity',
      recoverCta: 'I have a 24-word backup',
    },
    displayName: {
      ariaLabel: 'Pick a display name',
      heading: 'What should friends see?',
      body: 'Pick anything: your name, a nickname, an emoji. You can change it in Settings.',
      label: 'Display name',
      saveErrorFallback: "Couldn't save your name.",
    },
    permissions: {
      ariaLabel: 'Permissions',
      heading: 'A few permissions to study together',
      body: 'StudyVis only asks for what a session needs. You can change any of these later in Settings.',
      privacyNote:
        'Video and audio go straight to your friends. Nothing is recorded, nothing touches a server.',
      listAriaLabel: 'Permission list',
      headphonesHint:
        'Use headphones if you can. Built-in mics and speakers tend to echo once a few friends are talking.',
      denialNote: 'You can grant any of these later in Settings.',
      reopenHint:
        'After you allow camera or microphone in System Settings, reopen StudyVis so it takes effect.',
      grantedAriaLabel: (title: string) => `${title} permission granted`,
      grantedLabel: 'Granted',
      grantCta: 'Grant',
      tryAgainCta: 'Try again',
      openSettingsCta: 'Open settings',
      openSettingsErrorFallback: "Couldn't open System Settings.",
      rows: {
        camera: {
          title: 'Camera',
          description: 'Lets your friends see you while you study together.',
        },
        microphone: {
          title: 'Microphone',
          description: 'Stays muted until you hold the talk key.',
        },
        notifications: {
          title: 'Notifications',
          description: "So you see invites when StudyVis isn't focused.",
        },
      },
    },
    addFriend: {
      ariaLabel: 'Add your first friend',
      heading: 'Add your first friend',
      body: 'You and a friend each generate a one-time code; pasting it on the other side pairs you. After that, sessions are one click.',
      addCta: 'Add a friend',
      paired: 'Paired. Now invite them to a session.',
      pairedDetail: "They'll be in your friends list when you're done.",
    },
    tutorial: {
      ariaLabel: 'How a session works',
      cta: 'Get started',
      heading: 'How a session works',
      body: 'Three things to know. You can re-read this any time from Settings.',
      listAriaLabel: 'Three tips',
      cards: {
        invite: {
          title: 'Invite a friend',
          body: "Click a friend in your list. Their app will ring; if they take the call, you're in a session together.",
        },
        talk: {
          title: 'Talk when you mean to',
          bodyBeforeKbd: "You're muted by default. Hold ",
          bodyAfterKbd: ' to talk; let go to mute.',
        },
        leave: {
          title: 'Leave any time',
          body: 'Click Leave to drop out. The session ends for everyone when only one of you is left.',
        },
      },
    },
    step: {
      progressAriaLabel: (current: number, total: number) =>
        `Step ${current} of ${total}`,
    },
  },

  identity: {
    setup: {
      ariaLabel: 'Save your recovery phrase',
      heading: 'Save these 24 words somewhere safe',
      body: 'If you lose this laptop, these words are the only way to recover this identity. Pen and paper. No cloud sync.',
      // Shown when creating a new identity is refused because this device's
      // keychain already holds keys (e.g. identity.json was deleted but the
      // keychain entry survived). Creating fresh would abandon those keys, so
      // we steer the user back to the restore-from-backup path instead.
      keysExistError:
        'This device already has identity keys. Go back and choose "I have a backup" to restore them.',
    },
    backup: {
      wordlistAriaLabel: '24-word recovery phrase',
      copyAriaLabel: 'Copy 24 words to clipboard',
      copyCta: 'Copy to clipboard',
      copiedCta: 'Copied',
      acknowledge:
        "I've saved these words. I understand losing them means losing this identity.",
    },
    recover: {
      input: {
        ariaLabel: 'Recover your identity',
        cta: 'Recover',
        heading: 'Recover your identity',
        body: 'Type or paste your 24-word backup. The same keys come back on this device.',
        label: 'Recovery phrase',
        placeholder: 'ocean ladder cinnamon trumpet …',
        countLabel: (entered: number, total: number) =>
          `${entered} / ${total} words`,
        replaceNote: 'Replaces the identity on this device.',
      },
      confirm: {
        ariaLabel: 'Confirm replacing your identity',
        heading: 'Replace the identity on this device?',
        body: "This writes recovered keys over the ones already here. The current identity stays only on whatever device still has it, and this can't be undone.",
        cta: 'Replace identity',
      },
      // D5 — shown only when the typed words recompute to a DIFFERENT identity
      // than the one already on this device. The replacement is real and
      // friends won't recognize the new key until you re-pair, so the copy
      // names that consequence plainly without scare tactics.
      confirmDifferent: {
        ariaLabel: 'Confirm replacing with a different identity',
        heading: 'These are different words.',
        body: "This backup is a different identity from the one on this device. Restoring it replaces your current identity — friends who know your current key won't recognize the new one until you pair with them again. This can't be undone.",
        cta: 'Replace identity',
      },
      done: {
        ariaLabel: 'Identity restored',
        cta: 'Continue',
        heading: 'Identity restored.',
        body: "Your friends list didn't come with it. They don't know this device is you yet, so you'll pair with them again.",
        // D5 — same words re-committed over the identity already on this
        // device: friends and history are untouched, so the re-pair copy
        // above would be false here.
        bodySame:
          'Same identity, same device — your friends and history are untouched.',
      },
      errors: {
        empty: 'Type your 24-word backup to continue.',
        short: (wordCount: number) =>
          `That's ${wordCount} words. A backup has 24.`,
        long: (wordCount: number) =>
          `That's ${wordCount} words. A backup has exactly 24.`,
        invalid:
          "Those 24 words don't add up. Check for a typo or a word out of place against your written copy.",
      },
    },
    // D1 — shown when identity.json exists but couldn't be read. The keys are
    // still in the keychain; this screen never offers create-new (which would
    // overwrite them), only Retry and Recover-from-backup.
    loadError: {
      ariaLabel: "Couldn't read your identity",
      heading: "We couldn't read your identity file",
      body: "Your identity didn't load this time. Your keys are still safe in this device's keychain — this is usually a temporary read issue, so trying again often fixes it.",
      recoverNote:
        'Still stuck? If you have your 24-word backup, you can restore your identity from it.',
      retryCta: 'Try again',
      recoverCta: 'Restore from backup',
    },
    // #47 E1 — identity.json parsed fine but the keychain holds no private
    // keys (file-level backup restore, keychain/Credential Manager reset).
    // Signing and decrypting are impossible, so the 24-word restore leads;
    // retrying is offered only as the check-again fallback.
    keysMissing: {
      ariaLabel: 'Identity keys are missing',
      heading: 'Your identity keys are missing from this device',
      body: "Your identity file is fine, but this device's keychain no longer has the private keys behind it — this can happen after restoring files onto a new machine or resetting the keychain. Restore from your 24-word backup to get them back.",
      recoverNote:
        'Restoring from your 24-word backup brings back the exact same identity — your friends and history stay intact.',
      retryCta: 'Check again',
      recoverCta: 'Restore from backup',
    },
  },

  friends: {
    list: {
      heading: 'Friends',
      addCta: 'Add friend',
      empty: 'Add a friend to start studying together.',
      available: 'Available',
      offline: 'Offline',
      inviteCta: 'Invite',
      inviteAriaLabel: (name: string) => `Invite ${name}`,
      lastTogether: {
        never: 'never studied together',
        today: 'last together · today',
        yesterday: 'last together · yesterday',
        daysAgo: (n: number) => `last together · ${n} days ago`,
        weeksAgo: (n: number) =>
          `last together · ${n} week${n === 1 ? '' : 's'} ago`,
        monthsAgo: (n: number) =>
          `last together · ${n} month${n === 1 ? '' : 's'} ago`,
        yearsAgo: (n: number) =>
          `last together · ${n} year${n === 1 ? '' : 's'} ago`,
      },
    },
    addDialog: {
      missingName: {
        title: 'Finish onboarding first',
        body: "Pick a display name in onboarding first. It's how friends will see you when you pair.",
        cta: 'Got it',
      },
      pair: {
        title: 'Add a friend',
        description: (wordCount: number) =>
          `Share a one-time ${wordCount}-word code over any chat. The code is good for one pairing and then discarded.`,
        tabs: {
          generate: 'Generate code',
          enter: 'Enter code',
        },
      },
      host: {
        codeAriaLabel: 'One-time pairing code',
        qrAlt: 'QR code containing your one-time pairing link',
        qrCaption: 'Have your friend scan this — or send them the link below.',
        // F9 — the ~10-minute one-time-use lifetime is otherwise invisible.
        freshnessNote:
          'One-time use. If a while has passed, close and reopen this to generate a fresh code.',
        copyAriaLabel: 'Copy pairing link to clipboard',
        copyCta: 'Copy link',
        copiedCta: 'Copied',
        connected: 'Friend joined. Exchanging keys.',
        waiting: 'Waiting for your friend to enter the code.',
        stillWaiting:
          'Still waiting. Make sure your friend opened the Enter-code tab and typed this exact code.',
        // F1 — distinct from stillWaiting: this blames the network, not the
        // friend. Shown when trystero reports a join error (e.g. the relays
        // are unreachable, or the other side is on a different code).
        networkTrouble:
          'Trouble reaching the network. Check your connection — some school or office networks block it. You can see relay status in Settings → Network.',
        // F5 — peer arrived but no direct link formed (strict NAT, no TURN).
        linkStalled:
          "Connected to the network, but couldn't open a direct link to your friend. A strict firewall or NAT may be in the way — add a relay or TURN server in Settings → Network and try again.",
        introBody: (wordCount: number) =>
          `We'll generate ${wordCount} words. Send them to your friend over any messenger; they enter them on the other tab.`,
        generateCta: 'Generate code',
      },
      join: {
        ariaLabel: 'Pairing code words',
        wordAriaLabel: (index: number) => `Word ${index}`,
        notInWordlistSr: 'Not a valid BIP39 word',
        connected: 'Friend joined. Exchanging keys.',
        searching: 'Looking for your friend on the network.',
        hint: (wordCount: number) =>
          `Type the ${wordCount} words, or paste the code or link your friend sent. Only BIP39 words work; anything else is flagged as you type.`,
        validCount: (valid: number, total: number) =>
          `${valid} / ${total} valid`,
        notInWordlist: (count: number) => `${count} not in wordlist`,
        checksumHint:
          "These are all real words, but they don't form a valid code — check for a mistyped or swapped word.",
        pasteFailed:
          "Couldn't read a code from the clipboard. Paste it into a box instead.",
        scanCta: 'Scan QR',
        scanHint: "Point your camera at the QR code on your friend's screen.",
        scanAria: 'Camera preview for scanning a pairing QR code',
        scanNotRecognized: "That QR isn't a StudyVis pairing code.",
        cameraFailed:
          "Couldn't open the camera. Check its permission, or paste the code instead.",
        stillSearching:
          'Still searching. Make sure the other device generated this exact code and is online.',
        // F1 — network-trouble variant of stillSearching (blames the network,
        // not the other device).
        networkTrouble:
          'Trouble reaching the network. Check your connection — some school or office networks block it. You can see relay status in Settings → Network.',
        // F5 — peer found but no direct link formed (strict NAT, no TURN).
        linkStalled:
          "Found your friend, but couldn't open a direct link. A strict firewall or NAT may be in the way — add a relay or TURN server in Settings → Network and try again.",
        clearCta: 'Clear',
        pasteCta: 'Paste',
        connectCta: 'Connect',
      },
      success: {
        title: (name: string) => `Paired with ${name}.`,
        body: "They're now in your friends list.",
      },
      errors: {
        savingFriend: "Couldn't save your new friend.",
        pairingFailed: "Couldn't pair. Try again?",
      },
      defaultFriendName: 'your friend',
      // Offline ContactCard surface — the primary way to add a friend. You swap
      // self-contained codes (each carries only public keys) instead of meeting
      // live on a relay, so it works even when one of you is offline.
      card: {
        title: 'Add a friend',
        description:
          'Swap codes with your friend — no waiting for a connection, and it works even if one of you is offline.',
        yourCodeHeading: 'Your code',
        yourCodeCaption:
          'Send this to your friend so they can add you. It only holds your public keys — safe to share anywhere.',
        qrAlt: 'QR code containing your StudyVis friend code',
        qrCaption: 'Have your friend scan this, or send them the code below.',
        copyAriaLabel: 'Copy your friend code to clipboard',
        copyCta: 'Copy code',
        copiedCta: 'Copied',
        codeBuilding: 'Preparing your code…',
        codeError:
          "Couldn't prepare your code. Close and reopen this window to try again.",
        addHeading: "Add your friend's code",
        addBody: 'Scan their QR, or paste the code they sent you.',
        scanCta: 'Scan QR',
        pasteCta: 'Paste',
        addCta: 'Add',
        inputAriaLabel: "Your friend's code",
        scanHint: "Point your camera at the QR code on your friend's screen.",
        scanAria: 'Camera preview for scanning a friend code',
        notRecognized: "That isn't a StudyVis friend code.",
        cameraFailed:
          "Couldn't open the camera. Check its permission, or paste the code instead.",
        pasteFailed:
          "Couldn't read a code from the clipboard. Paste it into the box instead.",
        legacyLink: 'Friend on an older StudyVis? Use a pairing code',
        backToCards: '← Back',
      },
      // Confirm sheet shown after a friend's code is decoded — the safety-number
      // check is the man-in-the-middle defense on the remote (paste/link) path.
      importCard: {
        title: 'Add this friend?',
        body: (name: string) => `This code is for ${name}.`,
        idLabel: 'ID',
        fingerprintLabel: 'Safety number',
        fingerprintInstruction:
          'Check these digits match on both screens — read them aloud on a call or in person, not over the same chat that carried the code.',
        fingerprintConfirmLabel: 'These digits match on both screens',
        errorTitle: "Can't add this friend",
        addCta: 'Add friend',
        addedTitle: (name: string) => `Added ${name}.`,
        addedBody: 'Now send them your code so they can add you back.',
        fallbackName: 'your friend',
        selfError: "That's your own code — share it with a friend instead.",
        futureVersionError:
          'Update StudyVis to add this friend — their code uses a newer format.',
        corruptError:
          'This code is corrupt or unsupported. Ask your friend for a fresh one.',
        tamperError:
          'This code looks damaged or altered. Ask your friend to send it again.',
        savingError: "Couldn't save your new friend.",
        closeCta: 'Close',
      },
    },
    inbox: {
      senderFallback: 'A friend',
      inviteBody: (name: string) => `${name} invites you to study`,
      acceptAction: 'Accept',
    },
    inviteSent: (name: string) => `Invite sent to ${name}.`,
    inviteSendErrorFallback: "Couldn't send the invite.",
    joinErrorFallback: "Couldn't join the session.",
    // F6 — friend was offline; we couldn't deliver now, but the invite is held
    // and re-sent automatically the moment they come online (within a few
    // minutes). Distinct from inviteRelayError below, which blames the network.
    inviteTimeout:
      "Your friend looks offline. We'll deliver this the moment they come online — keep your session open.",
    // F1/F6 — the relays themselves were unreachable, so this is the user's own
    // network, not an offline friend. No retry is queued (the relay would be
    // just as unreachable), so the copy points at the network, not the friend.
    inviteRelayError:
      "Couldn't reach the network to send the invite. Check your connection — see relay status in Settings → Network.",
    inviteWhileGuest: 'Only the host can invite others to this session.',
  },

  session: {
    footerHoldBefore: 'Hold ',
    footerHoldAfter: ' to talk.',
    mainAriaLabel: 'Active session',
    mediaErrors: {
      denied: {
        title: 'Camera and mic access is blocked.',
        body: 'StudyVis needs your camera and microphone to share your study session. Allow access, then try again.',
      },
      notFound: {
        title: 'No camera or microphone found.',
        body: "We couldn't find a camera or microphone. Connect one, then try again.",
      },
      inUse: {
        title: 'Your camera or mic is busy.',
        body: 'Another app is using your camera or microphone. Close it, then try again.',
      },
      overconstrained: {
        title: "Your devices don't meet the requirements.",
        body: "Your camera or microphone doesn't support what this session needs. Try a different device, then try again.",
      },
      generic: {
        title: "We couldn't reach your camera or mic.",
        body: 'Something stopped StudyVis from using your camera and microphone. Try again.',
      },
      tryAgainCta: 'Try again',
      openSettingsCta: 'Open settings',
    },
    leaveCta: 'Leave',
    escLeaveHint: 'Press Esc again to leave.',
    // #47 A2 — mid-session invite (host only). Without it the first Invite
    // click locked the host into a 1:1 session; the 4-user mesh was
    // unreachable from the UI.
    invite: {
      cta: 'Invite',
      ctaAriaLabel: 'Invite a friend to this session',
      dialogTitle: 'Invite a friend',
      dialogDescription:
        'Online friends can join this session right away. Up to 4 people can study together.',
      emptyOnline: 'No friends online right now.',
      listAriaLabel: 'Online friends',
      rowCta: 'Invite',
      invitedLabel: 'Invited',
      rowInviteAriaLabel: (name: string) => `Invite ${name} to this session`,
    },
    // U2 — empty-peer waiting state (DESIGN-SYSTEM §10 empty-state: no
    // spinner, calm copy) shown alongside the self tile while alone.
    waiting: {
      // Never-had-peers: the most common first-session moment (you just
      // invited and are sitting alone).
      title: 'Waiting for your friend to join…',
      body: "Your session is live. They'll appear here as soon as they accept your invite.",
      // Emptied-after-peers (S1 grace window): a friend who'd joined dropped.
      // Reconnect-flavored, not invite copy — they already accepted.
      reconnectTitle: 'Waiting for your friend to reconnect…',
      reconnectBody:
        "Your session is still live. They'll reappear here if they come back.",
    },
    peerFallback: (id: string) => `Peer ${id.slice(0, 6)}`,
    selfFallback: 'You',
    broadcasterSelf: 'you',
    broadcasterFallback: 'another peer',
    topicGate: {
      title: 'What are you working on?',
      description:
        'StudyVis shares this with the AI so it can tell when you drift off-topic. You can change it any time during the session.',
      placeholder: 'e.g. Calculus problem set 4',
      ariaLabel: 'Study topic',
      submitCta: 'Start studying',
    },
    audit: {
      panelHeading: 'Session log',
      empty: 'Events will appear here as people join, leave, and take breaks.',
    },
    focusStates: {
      focused: 'On task',
      warning: 'Self-warning',
      alerted: 'Off task',
      online: 'Online',
      offline: 'Offline',
      onBreak: 'On break',
      // F4 — WebRTC connection states surfaced on peer tiles so a mid-ICE
      // handshake or a failed connection no longer reads as a frozen offline
      // tile.
      connecting: 'Connecting…',
      failed: 'Connection failed',
    },
    badges: {
      selfWarningAriaLabel: 'Self-warning',
      selfWarningTitle: 'Heads up, looking off-task.',
      breakAriaLabel: 'Break countdown',
      breakTitle: 'On a break',
      breakRemaining: (label: string) => `${label} remaining`,
    },
    aiStatus: {
      off: 'AI off',
      active: 'AI watching',
      paused: 'AI paused',
      error: 'AI error',
    },
    elapsed: {
      label: 'Elapsed',
      ariaLabel: (time: string) => `Time elapsed ${time}`,
    },
    audio: {
      systemDefault: 'System default',
      micAriaLabel: (label: string) => `Microphone, currently ${label}`,
      menuLabel: 'Microphone',
      empty: 'No microphones detected',
    },
    // S3 — local camera on/off control + the explicit peer presentation when
    // someone has their camera off (a paused tile, never a frozen frame).
    camera: {
      // Constant toggle label — pairs with aria-pressed so screen readers
      // announce "Camera, pressed/not pressed" rather than double-encoding the
      // state ("Turn camera on, pressed").
      toggleAriaLabel: 'Camera',
      offTileLabel: 'Camera off',
    },
    // S4 — audio output device picker + per-peer volume.
    output: {
      menuLabel: 'Speaker',
      ariaLabel: (label: string) => `Speaker, currently ${label}`,
      systemDefault: 'System default',
      empty: 'No speakers detected',
      volumeAriaLabel: (name: string) => `Volume for ${name}`,
    },
    errors: {
      leaveFailedFallback: "Couldn't leave the session.",
      switchMicFailedFallback: "Couldn't switch microphone.",
      requestAccessFallback: "Couldn't request access.",
      // #47 B2 — toast action that opens the in-session settings overlay at
      // the AI category (the copy above names it; the button honors it).
      openSettingsAction: 'Open settings',
      pickModel: 'Pick a model in Settings → AI.',
      modelFilesMissing:
        'Model files are missing. Re-download them in Settings → AI.',
      aiFailedToStart: 'AI failed to start.',
      aiFailedToStartDetail: (detail: string) =>
        `AI failed to start: ${detail}.`,
      aiCaptureError: (message: string) => `AI capture error: ${message}.`,
      aiCrashed: 'AI model crashed. Restart it in Settings → AI.',
      aiCrashedDetail: (lastError: string) =>
        `AI model crashed (${lastError}). Restart it in Settings → AI.`,
      aiPausedForBattery: (percent: number) =>
        `AI paused to save battery (${percent}%). Plug in or charge above 20% to resume.`,
      aiResumed: 'AI resumed.',
      // A6 — one-shot notice when the duration-based cadence backoff engages
      // (the model is running slower than measured, so checks are spaced out
      // to give your machine room to cool).
      aiSlowedDown:
        'Checks are running slower than usual, so StudyVis is spacing them out to ease the load on your machine.',
    },
    full: 'This session is full (4 friends max).',
    // N4 — quit-during-session confirm. Fired when the user tries to quit
    // (window close with minimize-to-tray off, tray Quit, macOS Cmd+Q) while
    // a session is live. The quit was already prevented by Rust; confirm
    // invokes app_quit(), cancel just closes.
    quitConfirm: {
      title: 'Leave your session and quit?',
      body: "You're in a live session. Quitting now drops you from the call and ends your session for everyone.",
      cancelCta: 'Stay',
      confirmCta: 'Leave and quit',
    },
  },

  pomodoro: {
    label: 'Pomodoro',
    phaseLabels: {
      'work-25': 'Focus',
      'rest-5': 'Break',
      'work-50': 'Focus',
      'rest-10': 'Break',
      'work-custom': 'Focus',
      'rest-custom': 'Break',
    },
    triggerAriaLabel: (phaseLabel: string, time: string) =>
      `Pomodoro ${phaseLabel} ${time}`,
    triggerIdleAriaLabel: 'Open Pomodoro menu',
    controlsAriaLabel: 'Pomodoro controls',
    activeTitle: (phaseLabel: string, preset: string) =>
      `${phaseLabel} · ${preset}`,
    drivingSelf: "You're driving the timer.",
    drivenBy: (name: string) => `Driven by ${name}.`,
    stopCta: 'Stop Pomodoro',
    startTitle: 'Start a Pomodoro',
    presetLegend: 'Preset',
    presets: {
      '25/5': {
        label: '25 / 5',
        hint: '25-minute focus, 5-minute break',
      },
      '50/10': {
        label: '50 / 10',
        hint: '50-minute focus, 10-minute break',
      },
      custom: {
        label: 'Custom',
        hint: 'Pick your own focus and break lengths',
      },
    },
    custom: {
      workLabel: 'Focus (min)',
      restLabel: 'Break (min)',
      workAriaLabel: 'Custom focus length in minutes',
      restAriaLabel: 'Custom break length in minutes',
      bounds: (
        workMin: number,
        workMax: number,
        restMin: number,
        restMax: number
      ) => `Focus ${workMin}–${workMax} min · break ${restMin}–${restMax} min`,
    },
    startCta: 'Start',
  },

  report: {
    notFound: 'Session not found.',
    loadErrorFallback: "Couldn't load the report.",
    loading: `Loading report${ELLIPSIS}`,
    ariaLabel: 'Session report',
    eyebrow: 'Session report',
    summaryPrefix: 'Studied for ',
    summaryMinutes: (n: number) => `${n} min`,
    summaryMiddle: ' · Focused-time ',
    privacy:
      'Reports stay on this device. Friends never see your score breakdown unless you share it.',
    sections: {
      topic: { heading: 'Topic', empty: 'No topic recorded.' },
      timeline: { heading: 'Timeline', empty: 'No events were recorded.' },
      distractions: {
        heading: 'Top distractions',
        empty: 'No distractions detected. Nice work.',
      },
      breaks: {
        heading: 'Breaks',
        empty: 'No breaks were taken.',
        count: (n: number) => `${n} ${n === 1 ? 'break' : 'breaks'}`,
      },
    },
    studiedFallback: 'Studied',
    studiedWithTopic: (topic: string) => `Studied ${topic}`,
    detailsFallback: 'Session details',
    error: "Couldn't load the report.",
    scoreLine: (n: number) => `Score: ${n}/100`,
    // R1 — unscored session: no gauge, no fabricated 100. Score is null both
    // when AI was off AND when AI ran but no sample was ever confident, so the
    // copy stays cause-neutral rather than asserting "AI was off".
    noScore: {
      heading: 'No focus score',
      body: 'No focus score was recorded for this session.',
      copyLine: 'Score: not recorded',
    },
    copyCta: 'Copy report',
    copyAriaLabel: 'Copy session report to clipboard',
    export: {
      saveCta: 'Save as…',
      saveAriaLabel: 'Save session report to a file',
      auditCta: 'Audit log (JSON)',
      auditAriaLabel: 'Save raw audit log for this session as JSON',
      reportFilterName: 'Markdown',
      auditFilterName: 'JSON',
      savedToast: 'Report saved.',
      auditSavedToast: 'Audit log saved.',
      errorToast: "Couldn't save the file.",
    },
  },

  audit: {
    kindLabels: {
      joined: 'joined',
      left: 'left',
      paused_break: 'took a break',
      resumed: 'returned',
      pomodoro_start: 'started a Pomodoro',
      pomodoro_end: 'stopped the Pomodoro',
      ai_warning: 'got a self-warning',
      ai_alert: 'looking off-task',
      topic_set: 'set the topic',
      topic_change: 'changed topic',
      break_request: 'asked for a break',
      break_approved: 'took a break',
      break_denied: 'break was denied',
    } satisfies Record<AuditEventKind, string>,
  },

  settings: {
    layoutAriaLabel: 'Settings',
    openAriaLabel: 'Open settings',
    closeAriaLabel: 'Close settings',
    heading: 'Settings',
    fallbackLabel: 'Settings',
    sectionAriaLabel: (category: string) => `${category} settings`,
    navAriaLabel: 'Settings categories',
    nav: {
      identity: 'Identity',
      friends: 'Friends',
      sessions: 'Sessions',
      stats: 'Stats',
      appearance: 'Appearance',
      notifications: 'Notifications',
      shortcuts: 'Shortcuts',
      ai: 'AI',
      network: 'Network',
      advanced: 'Advanced',
      about: 'About',
    },

    identity: {
      heading: 'Identity',
      displayName: {
        label: 'Display name',
        help: 'Friends see this name next to your tile. You can change it any time.',
        placeholder: 'Your name',
        ariaLabel: 'Display name',
        saveCta: 'Save',
        savedToast: 'Name saved.',
        saveError: "Couldn't save your name.",
      },
      publicKey: {
        label: 'Public key',
        help: 'Your pseudonymous identity. Friends recognize you by this key + name.',
        copyAriaLabel: 'Copy public key',
      },
      recoveryPhrase: {
        label: 'Recovery phrase',
        // D4 — honest copy: the 24 words are never persisted, so they cannot
        // be re-shown here and lost words are unrecoverable by design.
        // Replacement semantics live in the Restore flow.
        help: "Your 24 words were shown once during setup and never saved — keep the original safe. Lost words can't be recovered; you'd start fresh and pair with your friends again.",
        restoreCta: 'Restore a different identity',
      },
      // D3 — local friends-list backup/restore, encrypted to your own key.
      // Pairs with the 24-word recovery, which restores only the keypair.
      friendsBackup: {
        label: 'Friends backup',
        help: 'Your 24 words restore your identity, but not your friends list. Save an encrypted copy to keep alongside them — only this identity can open it.',
        exportCta: 'Export friends',
        exportAriaLabel: 'Export your friends list to a file',
        importCta: 'Import friends',
        importAriaLabel: 'Import a friends list from a file',
        fileFilterName: 'StudyVis friends backup',
        exportDefaultName: 'studyvis-friends',
        exportedToast: (count: number) =>
          count === 1
            ? 'Saved 1 friend to your backup.'
            : `Saved ${count} friends to your backup.`,
        exportEmptyToast: 'No friends yet — nothing to back up.',
        exportErrorFallback: "Couldn't save your friends backup.",
        importedToast: (imported: number, updated: number) => {
          const added =
            imported === 1 ? '1 friend added' : `${imported} friends added`
          const refreshed = updated === 1 ? '1 updated' : `${updated} updated`
          return `Imported: ${added}, ${refreshed}.`
        },
        importDifferentIdentity:
          'That backup belongs to a different identity, so it stays encrypted. Use the backup you made with these 24 words.',
        importErrorFallback: "Couldn't import that friends backup.",
      },
    },

    friends: {
      heading: 'Friends',
      emptyLabel: 'No friends yet',
      emptyHelp: 'Pair with a friend from the main view to see them here.',
      removeAriaLabel: (name: string) => `Remove ${name}`,
      removeCta: 'Remove',
      confirm: {
        title: 'Remove this friend?',
        body: (name: string) =>
          `${name} will be removed from your friends list. To study together again you'll need to pair from scratch.`,
        cancelCta: 'Cancel',
        confirmCta: 'Remove',
      },
      removedToast: (name: string) => `Removed ${name}.`,
      removeErrorFallback: "Couldn't remove that friend.",
      defaultFriendName: 'your friend',
      defaultFriendDisplay: 'This friend',
    },

    sessions: {
      heading: 'Sessions',
      loadErrorLabel: "Couldn't load session history.",
      emptyLabel: 'No sessions yet',
      emptyHelp: 'Past sessions will appear here once you study with a friend.',
      loadingAriaLabel: 'Loading sessions',
      missing: '—',
      meta: {
        solo: 'solo',
        oneFriend: '1 friend',
        manyFriends: (n: number) => `${n} friends`,
        minutes: (n: number) => `${n} min`,
        score: (n: number) => `${n} / 100`,
      },
      // R4 — per-session delete behind an AlertDialog confirm, mirroring the
      // Friends remove pattern. Deleting removes the session row and its
      // audit events; stats/report read SQLite, so the change flows through.
      delete: {
        cta: 'Delete',
        ariaLabel: (when: string) => `Delete session from ${when}`,
        confirmTitle: 'Delete this session?',
        confirmBody:
          'This removes the session and its focus history from this device. It cannot be undone.',
        confirmCta: 'Delete',
        cancelCta: 'Cancel',
        deletedToast: 'Session deleted.',
        errorFallback: "Couldn't delete the session.",
      },
    },

    appearance: {
      heading: 'Appearance',
      theme: {
        label: 'Theme',
        help: 'Switches the entire app immediately.',
        ariaLabel: 'Theme',
        options: {
          dark: 'Dark',
          light: 'Light',
          auto: 'Auto (follow system)',
        },
      },
      windowStyle: {
        label: 'Window style',
        helpRelaunchOnly: 'Applies on next relaunch.',
        helpRelaunchAndDescribe:
          'Replaces the native title bar with our own. Applies after a relaunch.',
        ariaLabel: 'Window style',
        options: {
          system: 'System',
          custom: 'Custom',
        },
        relaunchCta: 'Relaunch now',
      },
      reduceMotion: {
        label: 'Reduce motion',
        help: 'Collapses transitions and animations to a fade. Picks this up automatically if your OS already has reduce-motion on.',
        ariaLabel: 'Reduce motion',
      },
    },

    notifications: {
      heading: 'Notifications',
      invites: {
        label: 'Incoming invite notifications',
        help: 'OS-level prompt when a friend invites you to study. The in-app toast always fires.',
        ariaLabel: 'Incoming invite notifications',
      },
      tray: {
        label: 'Minimize to tray on close',
        help: 'When on, closing the window keeps StudyVis in the tray so friends can still reach you. When off, closing exits the app.',
        ariaLabel: 'Minimize to tray on close',
      },
      // N2 — opt-out: ON by default. The boundary is invisible when the
      // window is minimized to the tray, so this is the most-wanted nudge.
      pomodoro: {
        label: 'Pomodoro break notifications',
        help: "OS prompt when your focus block flips to a break, and back. Skipped while you're looking at the timer.",
        ariaLabel: 'Pomodoro break notifications',
      },
      // N6 — opt-in: OFF by default (the calm default IS the accommodation;
      // no extra reduced-motion gate needed since nothing plays unless asked).
      pomodoroSound: {
        label: 'Pomodoro chime',
        help: 'Plays a short, quiet chime when your focus block flips to a break, and back. Off by default.',
        ariaLabel: 'Pomodoro chime',
      },
      // N3 — opt-in: OFF by default. Honest about the ~60s presence latency.
      friendOnline: {
        label: 'Friend-online notifications',
        help: "OS prompt when a friend comes online — a good moment to invite them. Off by default; can lag a friend's arrival by up to a minute.",
        ariaLabel: 'Friend-online notifications',
      },
    },

    shortcuts: {
      heading: 'Shortcuts',
      pttFriends: {
        label: 'Push to talk · friends',
        help: 'Hold to unmute your microphone for everyone in the session.',
      },
      pttAi: {
        label: 'Talk to AI',
        helpOn: 'Opens the floating AI dialog over any app.',
        helpOff: 'Active when AI features are on.',
      },
      reset: {
        label: 'Reset to defaults',
        help: 'Restores the original combos for both shortcuts.',
        cta: 'Reset',
      },
    },

    ai: {
      heading: 'AI',
      // One privacy statement for the pane; the enable row's help and the
      // model row already say what turning AI on unlocks.
      intro:
        'The vision model runs on this machine and only looks at your camera and screen. Nothing leaves your computer.',
      // D5 — canonical screen-recording indicator note: the OS indicator
      // stays lit while sampling, and macOS grant/revoke lives in System
      // Settings. Rendered only while the AI gate is on.
      screenIndicatorNote:
        "While the AI is sampling, your operating system's screen-recording indicator stays on for the whole session. That's expected — it turns off when you leave. On macOS, screen-recording access is granted and revoked only in System Settings → Privacy & Security → Screen Recording; StudyVis can open it for you when needed.",
      enable: {
        label: 'Enable AI features',
        help: "Off by default. When off, StudyVis is a plain study room — no model, no capture, no scoring. We'll ask for screen access when you turn AI on.",
        ariaLabel: 'Enable AI features',
      },
      modelOff: {
        label: 'AI is off',
        help: 'Enable AI features above to choose and benchmark a vision model and tune how often it samples.',
      },
      sampleInterval: {
        label: 'Sample interval',
        help: (measuredFloor: number, max: number) =>
          `How often the model looks (seconds). The floor is what this machine measured (${measuredFloor}s); you can only slow it down, up to ${max}s. Takes effect on the next sample.`,
        ariaLabel: 'Sample interval (seconds)',
      },
      warnAfter: {
        label: 'Warning after',
        help: 'Consecutive off-task samples before StudyVis warns you privately (only you see it).',
        ariaLabel: 'Warning after N off-task samples',
      },
      alertAfter: {
        label: 'Alert peers after',
        help: 'Consecutive off-task samples before your friends see you flagged. Always kept above the warning count.',
        ariaLabel: 'Alert peers after N off-task samples',
      },
      // A3 — off-task sensitivity. The slider is the on-topic-confidence floor
      // an off-task call must clear to be SKIPPED, so higher = more off-task
      // calls survive the gate and count = more flags. Copy below reads in that
      // (correct) direction; the code gate lives in scoreMachine.step().
      confidenceFloor: {
        label: 'Off-task sensitivity',
        help: 'Higher counts more of the model’s off-task calls against you (more flags). Lower skips the calls the model only half-doubts, so only confident off-task moments count (fewer false alarms). Skipped samples are never held against you.',
        ariaLabel: 'Off-task sensitivity',
      },
      // D5/V3-P4 — captureDisplays. Note: sharpened to match the V3-P4
      // contract: "All displays" prompts the OS share picker once per
      // monitor at session start; switching primary→all mid-session takes
      // effect on the next session (the no-mid-session-prompt invariant).
      captureDisplays: {
        label: 'Capture displays',
        help: 'All displays sends every monitor to the local AI as one image. Peers never see your screen. The OS share picker runs once per monitor at session start; changes between primary and all apply on the next session.',
        ariaLabel: 'Capture displays',
        options: {
          primary: 'Primary only',
          all: 'All displays',
        },
      },
      diagnostics: {
        label: 'AI diagnostics in debug log',
        help: 'AI sample/parse warnings are written to the developer console when the debug log is on. Same setting as Advanced → Debug log.',
        ariaLabel: 'AI diagnostics in debug log',
      },
      hfToken: {
        label: 'Hugging Face token',
        help: 'Stored in your OS keychain for gated model downloads (e.g. Gemma). Forgetting it does not delete already-downloaded models.',
        forgetCta: 'Forget',
        savedToast: 'Token saved to your keychain.',
        saveErrorPrefix: "Couldn't save the token: ",
        removedToast: 'Hugging Face token removed.',
        removeErrorPrefix: "Couldn't remove the token: ",
      },
      sidecar: {
        label: 'AI model crashed',
        helpLastError: (lastError: string) => `Last error: ${lastError}`,
        helpExhausted: 'The AI tried to restart a few times and gave up.',
        restartCta: 'Restart',
        restartedToast: 'AI model restarting.',
        restartErrorFallback: "Couldn't restart the model.",
        pickModelFirstToast: 'Pick a model first.',
      },
      permissions: {
        grantedToast: 'Screen recording granted.',
        requestErrorFallback: "Couldn't request access.",
        // D5 — onboarding/first-session prompt before screen access exists.
        pickModelFirstBody:
          'Pick and download a model now. StudyVis asks for screen access when AI is on — your OS recording indicator will stay lit for the whole session.',
      },
    },

    network: {
      heading: 'Network',
      about: {
        label: 'About connections',
        // F8 — STUN-only by default. No TURN relay ships, so the old "a relay
        // passes the traffic along" promise was untrue on a fresh install. Be
        // honest: direct only, unless YOU add a TURN server (F3, below).
        help: 'StudyVis connects you to friends directly. If a strict network (corporate firewall, locked-down Wi-Fi) blocks that, add your own TURN relay below — traffic stays end-to-end encrypted either way.',
      },
      preference: {
        label: 'TURN preference',
        // F8 — the help no longer claims a relay that doesn't exist. The
        // preference only does anything once a TURN server is configured (F3);
        // with none, every option is STUN-only.
        // The radio labels below spell out what each option does; the help
        // carries only what the labels can't — the no-server caveat.
        help: 'Only takes effect once you add a TURN server below; with none configured, every option is direct-only.',
        ariaLabel: 'TURN preference',
        options: {
          auto: 'Auto (use TURN when direct fails)',
          always: 'Always route through TURN',
          never: 'Never use TURN',
        },
      },
      // F2 — connection-diagnostics panel (per-relay live status).
      diagnostics: {
        label: 'Connection',
        help: 'Live status of the signaling relays StudyVis uses to find your friends. This is a local read — nothing is sent anywhere.',
        empty: 'No relay connections yet. They open a moment after launch.',
        status: {
          connected: 'Connected',
          connecting: 'Connecting…',
          down: 'Not connected',
        },
        // Screen-reader summary of the per-relay dot (color is never the only
        // signal — the text label above carries the same meaning visually).
        dotAriaLabel: (url: string, status: string) => `${url}: ${status}`,
      },
      // F3 — Advanced disclosure for user-supplied relay URLs + one TURN server.
      advanced: {
        toggleLabel: 'Advanced connection settings',
        toggleHelp:
          'Add your own Nostr relays and a TURN server. Most people never need these — leave them empty to use the built-in defaults.',
        relays: {
          label: 'Custom signaling relays',
          help: 'One wss:// URL per line. StudyVis uses these in addition to its built-in relays, so adding your own never cuts you off from friends on the defaults. Leave empty to use just the defaults. Restart StudyVis to apply a change.',
          placeholder: 'wss://relay.example.com',
          ariaLabel: 'Custom signaling relay URLs, one per line',
          invalid:
            'Each line must be a wss:// URL. Lines that aren’t were ignored.',
        },
        turn: {
          label: 'TURN server',
          help: 'A TURN relay gets you through strict firewalls and NATs. Self-host coturn, or use a provider. All three fields are required to enable it.',
          urlLabel: 'TURN URL',
          urlPlaceholder: 'turn:turn.example.com:3478',
          urlAriaLabel: 'TURN server URL',
          usernameLabel: 'Username',
          usernameAriaLabel: 'TURN username',
          credentialLabel: 'Password',
          credentialAriaLabel: 'TURN password',
          invalidUrl: 'TURN URL must start with turn: or turns:',
          active: 'TURN server active — the preference above now applies.',
        },
      },
    },

    advanced: {
      heading: 'Advanced',
      autostart: {
        label: 'Launch StudyVis at login',
        help: 'Off by default. The app stays in the tray to receive invites.',
        ariaLabel: 'Launch StudyVis at login',
      },
      autostartUnavailable: {
        label: 'Autostart unavailable',
        help: 'This only works in the packaged app, not the dev build.',
      },
      autostartError: {
        label: 'Autostart error',
      },
      debugLog: {
        label: 'Debug log',
        help: 'Logs verbose diagnostic output to the developer console. Off by default; persists across launches.',
        ariaLabel: 'Debug log',
      },
      dataFolder: {
        label: 'Open data folder',
        help: 'Reveals the directory holding your local SQLite database and identity record.',
        openCta: 'Open',
        errorFallback: "Couldn't open the data folder.",
      },
      shareLog: {
        label: 'Share log',
        help: 'When the AI misbehaves, copy a short diagnostics summary or open the log file, then send it to a friend or paste it into a GitHub issue. Nothing is uploaded — sharing is always manual.',
        copyCta: 'Copy diagnostics',
        revealCta: 'Open log',
        copiedToast: 'Diagnostics copied to the clipboard.',
        copyError: "Couldn't copy the diagnostics.",
        revealError: "Couldn't open the log file.",
        summary: (v: {
          version: string
          os: string
          arch: string
          logPath: string
        }) =>
          `StudyVis ${v.version}\nOS: ${v.os} (${v.arch})\nLog: ${v.logPath}`,
      },
      replayOnboarding: {
        label: 'Replay onboarding',
        help: 'Restarts the welcome → permissions → tutorial flow from the beginning. Your identity and friends are kept.',
        replayCta: 'Replay',
        scheduledToast: 'Onboarding will play on the next launch.',
      },
      // R4 — destructive "Clear all history" with a stronger confirm than the
      // per-session delete. Wipes every session row and all audit events;
      // identity and friends are untouched (different tables / the keychain).
      clearHistory: {
        label: 'Clear all session history',
        help: 'Permanently deletes every past session and its focus history from this device. Your identity and friends are kept.',
        clearCta: 'Clear history',
        confirmTitle: 'Clear all session history?',
        confirmBody:
          'This permanently deletes every past session and all focus history on this device. Your identity and friends are kept. This cannot be undone.',
        confirmCta: 'Clear everything',
        cancelCta: 'Cancel',
        clearedToast: 'Session history cleared.',
        errorFallback: "Couldn't clear your history.",
      },
    },

    about: {
      heading: 'About',
      app: {
        label: 'StudyVis',
        help: 'Peer-to-peer study app for friends. Local-first, no backend.',
      },
      version: {
        label: 'Version',
      },
      copyright: {
        label: 'Copyright',
        line: (year: number) => `© ${year} Scott. All rights reserved.`,
      },
      releases: {
        label: 'Releases',
        help: "StudyVis doesn't auto-update. Check here when a new version drops.",
        openCta: 'Open',
        errorFallback: "Couldn't open the Releases page.",
      },
      // X4 — opt-in version check, OFF by default. The toggle is the one
      // sanctioned outbound request (PLAN §3 carve-out); off means zero calls.
      versionCheck: {
        label: 'Check for new versions',
        help: 'Off by default. When on, StudyVis asks GitHub once on this screen whether a newer release exists. It sends no data about you.',
        ariaLabel: 'Check for new versions',
      },
      // X4 — quiet "newer version available" row, shown only when the check
      // succeeds and finds a newer tag.
      updateAvailable: {
        label: 'Update available',
        help: (latest: string) => `Version ${latest} is available.`,
      },
    },
  },

  stats: {
    heading: 'Stats',
    disclaimer:
      'Computed on this device from your local session history. Nothing is sent anywhere.',
    loadErrorFallback: "Couldn't load your stats.",
    empty:
      'No stats yet. Study with a friend for at least a few minutes and your history will show up here.',
    loadingAriaLabel: 'Loading stats',
    streak: {
      label: 'Current streak',
      unit: (n: number) => (n === 1 ? 'day' : 'days'),
      help: (minMinutes: number) =>
        `Days in a row with a session of ${minMinutes}+ min`,
    },
    avgScore: {
      label: 'Average score',
      unit: '/ 100',
      helpNoScores: 'No scored sessions yet',
      help: (scoredSessions: number) =>
        `Across ${scoredSessions} scored ${
          scoredSessions === 1 ? 'session' : 'sessions'
        }`,
      // R6 — when only a small share of sessions are AI-scored, the average
      // over-reads. Surface the denominator prominently ("from 2 of 40
      // sessions") so the number is read honestly.
      coverage: (scored: number, total: number) =>
        `From ${scored} of ${total} ${total === 1 ? 'session' : 'sessions'}`,
      limitedData: 'Limited data',
    },
    studyMinutes: {
      heading: 'Study minutes · last 30 days',
      minutes: (n: number) => `${n} ${n === 1 ? 'minute' : 'minutes'}`,
    },
    partners: {
      heading: 'Top study partners',
      empty:
        'No study partners yet. Solo sessions still count toward your streak.',
      sessions: (n: number) => `${n} ${n === 1 ? 'session' : 'sessions'}`,
    },
    export: {
      cta: 'Export CSV',
      ariaLabel: 'Export stats as a CSV file',
      filterName: 'CSV',
      savedToast: 'Stats exported.',
      errorToast: "Couldn't export your stats.",
    },
    insights: {
      heading: 'Focus insights',
      // No subheading: the pane-level stats.disclaimer carries the on-device
      // privacy note and trend.help scopes the data to AI-scored sessions.
      noDistractions: 'No distractions recorded yet. Nice work.',
      empty:
        'No focus insights yet. Study a few sessions with AI focus detection on and patterns will show up here.',
      timing: {
        heading: 'When distractions happen',
        help: 'Across all your sessions, grouped by how far into a session each distraction landed.',
        empty: 'No distractions to place on a timeline yet. Nice work.',
        buckets: {
          early: 'First 15 min',
          mid: '15–45 min',
          late: 'After 45 min',
        },
        count: (n: number) =>
          `${n} ${n === 1 ? 'distraction' : 'distractions'}`,
      },
      reasons: {
        heading: 'Recurring distractions',
        help: 'The same reasons, tallied across every session — not just the last one.',
        empty: 'No recurring distractions yet. Nice work.',
        count: (n: number) => `${n}×`,
      },
      trend: {
        heading: 'Focus over time',
        help: 'Focused-time % for each AI-scored session, oldest to newest.',
        empty: 'Finish a couple of AI-scored sessions to see your trend.',
        point: (pct: number) => `${pct}% focused`,
      },
    },
  },

  ai: {
    picker: {
      ariaLabel: 'Vision model picker',
      heading: 'Pick a vision model',
      body: 'The model runs on your own machine and judges only your camera and screen. Smaller is faster; bigger is more thorough.',
      pills: {
        gated: 'Gated',
        installed: 'Installed',
        incomplete: 'Incomplete',
      },
      dataLabels: {
        download: 'Download',
        ram: 'RAM',
        license: 'License',
        quant: 'Quant',
      },
      cancelCta: 'Cancel',
      reBenchmarkCta: 'Re-benchmark',
      reDownloadCta: 'Re-download',
      downloadCta: 'Download',
      // A4 — shown when a partial download is known on disk; the backend
      // resumes from where it stopped via an HTTP Range request.
      resumeCta: 'Resume download',
      resumeNote: (received: string) =>
        `Picks up from where it stopped (${received} downloaded).`,
      removeAriaLabel: (name: string) => `Remove ${name}`,
      speedSummary: (p95Sec: number) =>
        `Speed on your machine: ${p95Sec.toFixed(1)} seconds per check`,
      phases: {
        idle: '',
        starting: `Starting${ELLIPSIS}`,
        downloadingModel: `Downloading model${ELLIPSIS}`,
        downloadingProjector: `Downloading projector${ELLIPSIS}`,
        verifying: `Verifying SHA-256${ELLIPSIS}`,
        loading: `Loading model into memory${ELLIPSIS}`,
        preparingBenchmark: `Preparing benchmark image${ELLIPSIS}`,
        runningSample: (i: number, n: number) =>
          `Running sample ${i} / ${n}${ELLIPSIS}`,
        benchmarking: `Benchmarking${ELLIPSIS}`,
        cancelling: `Cancelling${ELLIPSIS}`,
        failedFallback: 'Something went wrong.',
      },
      readyToast: (displayName: string, p95Sec: number) =>
        `${displayName} ready. Speed on your machine: ${p95Sec.toFixed(1)} s/check.`,
      removedToast: (displayName: string) => `Removed ${displayName}.`,
      removeErrorToast: (displayName: string, message: string) =>
        `Couldn't remove ${displayName}: ${message}`,
      hfRejectedDetailed: (status: number, repoSlug: string) =>
        `Hugging Face rejected the download (HTTP ${status}). Accept the terms at huggingface.co/${repoSlug} and paste a valid token.`,
      hfRejected: (status: number) =>
        `Hugging Face rejected the download (HTTP ${status}).`,
      headBadUrl: (url: string, status: number) =>
        `HEAD ${url} returned HTTP ${status}. The model manifest may be stale.`,
      sizeMismatch: (got: number, kind: string, want: number) =>
        `Server reported ${got} bytes for ${kind} but the manifest expects ${want}. The model manifest may be stale.`,
    },
    tokenPaste: {
      heading: 'Paste your Hugging Face access token',
      // Split around the two URL fragments so the component can render
      // them in font-mono while keeping the sentence body here.
      bodyBeforeRepo: 'This model is gated. Accept the terms at ',
      bodyAfterRepo: ' first, then paste a read-scope token from ',
      bodyTokensUrl: 'huggingface.co/settings/tokens',
      bodyAfterTokensUrl:
        '. Your token is stored in the OS keychain, never sent anywhere.',
      placeholder: 'hf_xxxxxxxxxxxxxxxxxxxxxxxxx',
      saveCta: 'Save',
      forgetCta: 'Forget',
      forgetAriaLabel: 'Forget saved Hugging Face token',
    },
    guide: {
      heading: 'What model should I pick?',
      body: "Smaller models run faster and use less RAM but describe the screen in less detail. Bigger models catch subtler off-task behavior. The numbers below come from your machine after the first benchmark; the dashes are tiers you haven't tried yet.",
      tableHeaders: {
        tier: 'Tier',
        model: 'Model',
        download: 'Download',
        ram: 'RAM',
        license: 'License',
        yourSpeed: 'Your speed',
      },
      measured: (p95Sec: number) => `${p95Sec.toFixed(1)} s / check (p95)`,
      footer:
        'The AI runs on your machine. Your camera and screen stay here. Friends see a flag, not a frame.',
    },
    dialog: {
      header: 'Ask the AI',
      hint: 'Esc to close',
      ariaLabel: 'Ask the AI',
      defaultPlaceholder: `Ask the AI${ELLIPSIS}`,
      disabledPlaceholder: `Thinking${ELLIPSIS}`,
      contextMissing: "Session context isn't loaded yet. Give it a moment.",
      breakNeedsApp:
        'Break requests need the dialog to be running inside the app.',
      timeout: 'No response from the session. Try again.',
      timeoutFallback: "Couldn't reach the session.",
      catchFallback: "That didn't go through. Try again?",
      closedReason: 'Dialog closed before a verdict arrived.',
      sessionNotReady: "The session isn't ready yet. Give it a moment.",
      unexpectedError: 'Something went wrong. Try again?',
    },
    agent: {
      sidecarOff:
        "AI isn't running yet. Turn it on in Settings → AI, then try again.",
      timeout: 'The assistant took too long.',
      httpStatus: (status: number) => `The assistant returned HTTP ${status}.`,
      parseFallback: "I didn't catch that. Say it another way?",
      topicUpdated: (topic: string) => `Topic updated to ${topic}.`,
      considering: (minutes: number) => `Considering a ${minutes}-min break.`,
      noReply: '(no reply)',
    },
    // Break-rule verdict reasons. These render inside an AiResponseBubble
    // after an icon, as standalone sentences — cap + period per §14.
    // Existing unit-test matchers (`/at least/`, `/capped/`, `/25 minutes/`,
    // MAX_BREAKS_PER_SESSION digit) still pass.
    breakReasons: {
      alreadyOnBreak: "You're already on a break.",
      quotaExceeded: (max: number) =>
        `You've already taken ${max} breaks this session.`,
      cooldown: (remainingMin: number) =>
        `Your last break was under 25 minutes ago. Try again in ${remainingMin} min.`,
      tooShort: (minSec: number) =>
        `Breaks need to be at least ${minSec} seconds.`,
      aiDeniedFallback: 'The assistant recommended against it.',
      approvedCapped: (display: string, maxMin: number) =>
        `Approved · ${display} (capped to the ${maxMin}-min max).`,
      approved: (display: string) => `Approved · ${display}.`,
    },
  },

  permissions: {
    screenCapture: {
      title: 'Allow screen recording',
      body: (isMac: boolean) =>
        `StudyVis needs to capture a still image of your screen so the on-device AI can check that your study session stays on topic. Screen frames never leave this ${
          isMac ? 'Mac' : 'computer'
        }.`,
      // D5 — canonical indicator note (matches settings.ai.screenIndicatorNote
      // content but in a shorter form for the overlay).
      indicatorNote:
        "Heads-up: your OS screen-recording indicator stays on for the whole session. That's expected — it turns off when you leave.",
      stepsMac: [
        'Click **Open Settings** below. On macOS, screen-recording access is granted or revoked only there.',
        'Toggle **StudyVis** on under **Screen Recording**.',
        'macOS may ask you to quit and reopen StudyVis. Do that, then come back and click **Try again**.',
      ] as const,
      stepsOther: [
        'When the screen-share picker appears, choose your primary display.',
        'Click **Share** to allow the on-device AI to read the frame.',
        'If the prompt was dismissed, click **Try again** below.',
      ] as const,
      cancelCta: 'Not now',
      openSettingsCta: 'Open Settings',
      tryAgainCta: 'Try again',
      openSettingsErrorFallback: "Couldn't open System Settings.",
    },
  },

  keybindings: {
    actionLabels: {
      'ptt-friends': 'Push to talk',
      'ptt-ai': 'Talk to AI',
    },
    actionLabelsLower: {
      'ptt-friends': 'push to talk',
      'ptt-ai': 'talk to AI',
    },
    capture: {
      pressKey: `Press a key${ELLIPSIS}`,
      rebind: 'Rebind',
      help: 'Press a combo, or Esc to cancel.',
      armAriaLabel: (actionLabel: string) =>
        `Press a combo for ${actionLabel}, or Escape to cancel`,
      rebindAriaLabel: (actionLabel: string) => `Rebind ${actionLabel}`,
    },
    conflicts: {
      modifierOnly: 'Press a key with the modifier, not just the modifier.',
      noModifier: 'Add Ctrl, Cmd, or Alt. A bare key would fire while typing.',
      selfConflict: (inline: string, otherActionLabel: string) =>
        `${inline} is already bound to ${otherActionLabel}. Pick another.`,
      reserved: (inline: string) =>
        `${inline} is reserved by the system. Pick another.`,
    },
  },

  chrome: {
    titleBar: {
      ariaLabel: 'Window titlebar',
      controlsAriaLabel: 'Window controls',
      wordmark: 'studyvis',
      buttons: {
        minimize: 'Minimize',
        restore: 'Restore',
        maximize: 'Maximize',
        close: 'Close',
      },
    },
    logoAriaLabel: 'studyvis',
  },

  notifications: {
    invite: {
      title: 'StudyVis',
      // Body comes from friends.inbox.inviteBody — sender-dependent.
    },
    // N2 — pomodoro work↔rest transition copy, both directions. §14 voice:
    // warm, brief, second person.
    pomodoro: {
      breakTitle: 'Time for a break',
      breakBody: 'Step away and rest your eyes for a bit.',
      workTitle: 'Back to work',
      workBody: 'Break over — settle back into your focus block.',
    },
    // N3 — "friend came online" copy. Body carries the friend's display name.
    friendOnline: {
      title: 'StudyVis',
      body: (name: string) => `${name} is now online`,
    },
  },

  errors: {
    leaveSessionFirst: 'Leave the current session before joining another.',
  },
} as const
