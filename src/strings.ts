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
      done: {
        ariaLabel: 'Identity restored',
        cta: 'Continue',
        heading: 'Identity restored.',
        body: "Your friends list didn't come with it. They don't know this device is you yet, so you'll pair with them again.",
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
        copyAriaLabel: 'Copy pairing link to clipboard',
        copyCta: 'Copy link',
        copiedCta: 'Copied',
        connected: 'Friend joined. Exchanging keys.',
        waiting: 'Waiting for your friend to enter the code.',
        stillWaiting:
          'Still waiting. Make sure your friend opened the Enter-code tab and typed this exact code.',
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
    },
    inbox: {
      senderFallback: 'A friend',
      inviteBody: (name: string) => `${name} invites you to study`,
      acceptAction: 'Accept',
    },
    inviteSent: (name: string) => `Invite sent to ${name}.`,
    inviteSendErrorFallback: "Couldn't send the invite.",
    joinErrorFallback: "Couldn't join the session.",
    inviteTimeout: "Your friend didn't pick up. They may be offline.",
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
    errors: {
      leaveFailedFallback: "Couldn't leave the session.",
      switchMicFailedFallback: "Couldn't switch microphone.",
      requestAccessFallback: "Couldn't request access.",
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
    },
    full: 'This session is full (4 friends max).',
  },

  pomodoro: {
    label: 'Pomodoro',
    phaseLabels: {
      'work-25': 'Focus',
      'rest-5': 'Break',
      'work-50': 'Focus',
      'rest-10': 'Break',
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
    copyCta: 'Copy report',
    copyAriaLabel: 'Copy session report to clipboard',
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
        help: "Your 24-word backup shows once during setup and isn't saved here. Keep the original safe — it's the only way to recover this identity, by re-deriving it on a fresh install.",
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
      intro:
        'The vision model runs on this machine and only looks at your camera and screen. Nothing leaves your computer. Turn AI on to pick a model, benchmark it, and let StudyVis nudge you when you drift off-task.',
      // D5 — canonical screen-recording indicator note. Reused by the
      // ScreenCapturePermissionOverlay so the user reads the same words
      // wherever the topic surfaces.
      screenIndicatorNote:
        "While the AI is sampling, your operating system's screen-recording indicator stays on for the whole session. That's expected — it turns off when you leave. On macOS, screen-recording access is granted and revoked only in System Settings → Privacy & Security → Screen Recording; StudyVis can open it for you when needed.",
      enable: {
        label: 'Enable AI features',
        help: "Off by default. When off, StudyVis is a plain study room — no model, no capture, no scoring. We'll ask for screen access when you start your first session.",
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
          "Pick and download a model now. We'll ask for screen access when you start a session — your OS recording indicator will stay lit for the whole session.",
      },
    },

    network: {
      heading: 'Network',
      about: {
        label: 'About TURN',
        help: "StudyVis connects you to friends directly when it can. Some networks (corporate firewalls, strict NATs) block that, so a relay server passes the traffic along instead. It's still encrypted end-to-end; the relay only ever sees encrypted bytes.",
      },
      preference: {
        label: 'TURN preference',
        help: 'Auto is recommended. Always-on burns more bandwidth on the public relay but can stabilize choppy connections. Never disables relay fallback entirely; sessions may fail to connect on strict networks.',
        ariaLabel: 'TURN preference',
        options: {
          auto: 'Auto (fall back when direct fails)',
          always: 'Always on',
          never: 'Never',
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
    },
    focused: {
      heading: 'Focused minutes · last 30 days',
      minutes: (n: number) => `${n} ${n === 1 ? 'minute' : 'minutes'}`,
    },
    partners: {
      heading: 'Top study partners',
      empty:
        'No study partners yet. Solo sessions still count toward your streak.',
      sessions: (n: number) => `${n} ${n === 1 ? 'session' : 'sessions'}`,
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
  },

  errors: {
    leaveSessionFirst: 'Leave the current session before joining another.',
  },
} as const
