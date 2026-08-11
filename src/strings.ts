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

  diagnostics: {
    defaultFilename: 'studyvis-diagnostics.zip',
    filterName: 'ZIP archive',
    downloadCta: 'Download diagnostics',
    preparingCta: `Preparing${ELLIPSIS}`,
    downloadAriaLabel: 'Download StudyVis app and local AI engine diagnostics',
    savedToast: 'Diagnostics saved.',
    errorToast: "Couldn't save the diagnostics.",
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
      body: 'Four things to know. You can re-read this any time from Settings.',
      listAriaLabel: 'Four tips',
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
          body: 'Click Leave to drop out. If that was a mistake, rejoin within 20 seconds before the session ends.',
        },
        ai: {
          title: 'AI is optional',
          body: 'AI starts off. Download and choose a model in Settings → AI. Benchmark before a session — or while AI is off in one — for timing tuned to this computer; you can still use the model without it.',
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
        unknownWords: (shown: string[], total: number) => {
          const quoted = shown.map((w) => `"${w}"`)
          if (total === 1) {
            return `${quoted[0]} isn't a backup word — check it against your written copy.`
          }
          const remaining = total - shown.length
          const named =
            remaining > 0
              ? `${quoted.join(', ')}, and ${remaining} more`
              : quoted.join(', ')
          return `${named} aren't backup words — check them against your written copy.`
        },
      },
    },
    loadError: {
      ariaLabel: "Couldn't read your identity",
      heading: "We couldn't read your identity file",
      body: "Your identity didn't load this time. Your keys are still safe in this device's keychain — this is usually a temporary read issue, so trying again often fixes it.",
      recoverNote:
        'Still stuck? If you have your 24-word backup, you can restore your identity from it.',
      retryCta: 'Try again',
      recoverCta: 'Restore from backup',
    },
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
    loadError: "Couldn't load your friends list.",
    list: {
      heading: 'Friends',
      addCta: 'Add friend',
      empty: 'Add a friend to start studying together.',
      available: 'Available',
      availableLimited: 'Available · limited connection',
      limitedTitle:
        "You can see each other, but a direct connection isn't forming — video sessions may not connect.",
      offline: 'Offline',
      offlineSeen: {
        justNow: 'Offline · seen just now',
        minutesAgo: (n: number) => `Offline · seen ${n} min ago`,
        hoursAgo: (n: number) => `Offline · seen ${n} hr ago`,
      },
      limitedHint: {
        body: "A direct connection to some friends isn't forming, so video sessions may not connect. A TURN relay in Network settings usually fixes this.",
        cta: 'Network settings',
      },
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
        freshnessNote:
          'One-time use. If a while has passed, close and reopen this to generate a fresh code.',
        copyAriaLabel: 'Copy pairing link to clipboard',
        copyCta: 'Copy link',
        copiedCta: 'Copied',
        connected: 'Friend joined. Exchanging keys.',
        waiting: 'Waiting for your friend to enter the code.',
        stillWaiting:
          'Still waiting. Make sure your friend opened the Enter-code tab and typed this exact code.',
        networkTrouble:
          'Trouble reaching the network. Check your connection — some school or office networks block it. You can see relay status in Settings → Network.',
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
        networkTrouble:
          'Trouble reaching the network. Check your connection — some school or office networks block it. You can see relay status in Settings → Network.',
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
      pending: {
        listAriaLabel: 'Pending invites',
        expiresIn: (min: number) => `Expires in ${min} min`,
        dismissCta: 'Dismiss',
        dismissAriaLabel: (name: string) => `Dismiss the invite from ${name}`,
        acceptAriaLabel: (name: string) => `Accept the invite from ${name}`,
        expired: 'That invite expired. Ask your friend to invite you again.',
        friendUnavailable:
          'That invite is no longer available because the sender is no longer in your friends list.',
      },
    },
    inviteSent: (name: string) => `Invite sent to ${name}.`,
    inviteSentUnconfirmed: (name: string) =>
      `Invite sent to ${name} — no confirmation from their app yet. If nothing happens, make sure they've added you back.`,
    inviteSendErrorFallback: "Couldn't send the invite.",
    joinErrorFallback: "Couldn't join the session.",
    inviteTimeout:
      "Your friend looks offline. We'll deliver this the moment they come online — keep your session open.",
    inviteRelayError:
      "Couldn't reach the network to send the invite. Check your connection — see relay status in Settings → Network.",
    inviteWhileGuest: 'Only the host can invite others to this session.',
  },

  session: {
    footerHoldBefore: 'Hold ',
    footerHoldAfter: ' to talk.',
    mainAriaLabel: 'Active session',
    gridAriaLabel: 'Session participants and shared screens',
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
    waiting: {
      title: 'Waiting for your friend to join…',
      body: "Your session is live. They'll appear here as soon as they accept your invite.",
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
    notes: {
      heading: 'Notes',
      empty:
        'Quiet notes and images for your friends. Shared content is kept only for this session. Downloaded images are saved where you choose.',
      placeholder: 'Type a note…',
      inputAriaLabel: 'Note to your session',
      sendAriaLabel: 'Send the note',
    },
    chat: {
      heading: 'Chat',
      group: 'Group',
      ai: 'StudyVis AI',
      addConversation: 'Add conversation',
      conversations: 'Conversations',
      directMessages: 'Direct messages',
      aiDescription: 'Private, local AI with context from this session.',
      aiDisabled: 'Enable AI features and select a model to use StudyVis AI.',
      aiEmpty: 'Ask StudyVis AI about your current study session.',
      aiPlaceholder: 'Message StudyVis AI…',
      aiInputAriaLabel: 'Message StudyVis AI',
      sendAiAriaLabel: 'Send message to StudyVis AI',
      aiUnavailable: 'The local AI is unavailable.',
      aiFailed: 'The local AI could not respond.',
      aiTimedOut: 'The local AI response timed out.',
      aiHttpStatus: (status: number) => `The local AI returned HTTP ${status}.`,
      thinking: 'Thinking…',
      you: 'You',
      dmEmpty: 'No direct messages yet.',
      dmPlaceholder: 'Write a direct message…',
      dmInputAriaLabel: (name: string) => `Direct message to ${name}`,
      sendDirectAriaLabel: (name: string) => `Send direct message to ${name}`,
      sendDirectFallbackAriaLabel: 'Send direct message',
      directMessageSendFailed: "Couldn't send the direct message.",
      peerUnavailable: 'This person is no longer in the session.',
      resize: 'Resize chat area',
      close: (name: string) => `Close ${name}`,
    },
    images: {
      attachImage: 'Send an image',
      openImage: (name: string) => `Open image from ${name}`,
      imageAlt: (name: string) => `Image sent by ${name}`,
      viewerTitle: (name: string) => `Image from ${name}`,
      zoomIn: 'Zoom in',
      zoomOut: 'Zoom out',
      resetZoom: 'Reset zoom',
      download: 'Download image',
      downloaded: 'Image saved.',
      downloadFailed: "Couldn't save the image.",
      unsupportedType: 'Choose a JPEG, PNG, WebP, or GIF image.',
      tooLarge: 'Images must be 5 MB or smaller.',
      invalidImage: "That file couldn't be read as an image.",
      sendFailed: "Couldn't send the image.",
    },
    focusStates: {
      focused: 'On task',
      warning: 'Self-warning',
      alerted: 'Off task',
      online: 'Online',
      offline: 'Offline',
      onBreak: 'On break',
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
      unconfigured: 'AI needs a model',
      active: 'AI watching',
      paused: 'AI paused',
      error: 'AI error',
      openSettingsAriaLabel: (status: string) => `${status}. Open AI settings`,
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
    camera: {
      toggleAriaLabel: 'Camera',
      offTileLabel: 'Camera off',
    },
    screenShare: {
      toggleAriaLabel: 'Share screen',
      startCta: 'Share',
      stopCta: 'Stop sharing',
      selfTileName: 'Your screen',
      peerTileName: (name: string) => `${name}'s screen`,
      expandAriaLabel: (name: string) => `View ${name} in fullscreen`,
      startedToast: "You're sharing your screen.",
      stoppedToast: 'You stopped sharing your screen.',
      entireScreenRequiredToast:
        "Try again and choose Entire Screen in the Windows picker. StudyVis won't share a single window or app.",
      entireScreenUnverifiedToast:
        "StudyVis couldn't verify that you chose Entire Screen, so sharing didn't start. Update Microsoft Edge WebView2, then try again.",
      blockedToast:
        "Screen sharing didn't start. If you didn't cancel it, allow StudyVis under Screen Recording, then try again.",
      failedToast: "Couldn't start screen sharing.",
      openSettingsCta: 'Open settings',
    },
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
      openSettingsAction: 'Open settings',
      pickModel: 'Pick a model in Settings → AI.',
      modelListUnreadable:
        "Your AI model list couldn't be read, so AI sat out this session. Open Settings → AI to try again.",
      modelFilesMissing:
        'Model files are missing. Re-download them in Settings → AI.',
      aiFailedToStart: 'AI failed to start.',
      aiFailedToStartDetail: (detail: string) =>
        `AI failed to start: ${detail}.`,
      engineNotInstalled:
        "The AI engine isn't installed. Install it in Settings → AI.",
      aiCaptureError: (message: string) => `AI capture error: ${message}.`,
      aiCrashed: 'AI model crashed. Restart it in Settings → AI.',
      aiCrashedDetail: (lastError: string) =>
        `AI model crashed (${lastError}). Restart it in Settings → AI.`,
      aiPausedForBattery: (percent: number) =>
        `AI paused to save battery (${percent}%). Plug in or charge above 20% to resume.`,
      aiResumed: 'AI resumed.',
      aiSlowedDown:
        'Checks are running slower than usual, so StudyVis is spacing them out to ease the load on your machine.',
      aiNoReading: {
        engine_warming:
          "AI hasn't managed a check yet — the engine is still starting up.",
        inference_timeout:
          'AI checks are timing out on this machine. A smaller model in Settings → AI will keep up better.',
        inference_failed:
          'The AI model is loaded but rejecting checks. Re-download it in Settings → AI — its vision files may be incomplete.',
        capture_failing:
          "AI can't read your camera or screen, so it isn't checking in.",
        camera_missing: "AI has no camera frame to check, so it's not running.",
        screen_lost: "Screen capture stopped, so AI isn't checking in.",
      },
      aiNoReadingLog: {
        engine_warming: 'the AI engine was still starting up',
        inference_timeout: 'the model took too long to answer',
        inference_failed: 'the model request kept failing',
        capture_failing: 'the camera or screen snapshot kept failing',
        camera_missing: 'there was no camera frame to check',
        screen_lost: 'screen capture had stopped',
      },
      aiReadingsResumed: 'AI is checking in again.',
    },
    full: 'This session is full (4 friends max).',
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
    rejoinCta: 'Rejoin session',
    dataQuality: (skipped: number, total: number) =>
      `${skipped} of ${total} AI checks couldn't be read and don't count toward focused time.`,
    loading: `Loading report${ELLIPSIS}`,
    ariaLabel: 'Session report',
    eyebrow: 'Session report',
    summaryPrefix: 'Studied for ',
    summaryMinutes: (n: number) => `${n} min`,
    summaryMiddle: ' · Focused-time ',
    privacy:
      'Reports stay on this device. Friends never see your score breakdown unless you share it.',
    identityUnavailable:
      'This session predates identity tracking, so local-only analysis cannot be reconstructed.',
    sections: {
      topic: { heading: 'Topic', empty: 'No topic recorded.' },
      timeline: { heading: 'Timeline', empty: 'No events were recorded.' },
      distractions: {
        heading: 'Top distractions',
        empty: 'No distractions detected. Nice work.',
        emptyNoChecks: 'No AI checks ran, so nothing was measured here.',
        emptyNoReadableChecks:
          'AI checks ran but none could be read, so nothing was measured here.',
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
    noScore: {
      heading: 'No focus score',
      body: 'No focus score was recorded for this session.',
      copyLine: 'Score: not recorded',
      bodyOff: 'AI focus detection was off for this session.',
      bodyNoChecks:
        'AI was on but never ran a check, so nothing was measured. Check Settings → AI.',
      bodyNoConfident:
        'AI ran, but no check could be read clearly, so nothing was measured.',
      copyLineOff: 'Score: not recorded (AI off)',
      copyLineNoChecks: 'Score: not recorded (AI ran no checks)',
      copyLineNoConfident: 'Score: not recorded (no readable AI checks)',
    },
    copyCta: 'Copy report',
    copyAriaLabel: 'Copy session report to clipboard',
    timelineResizeAriaLabel: 'Resize report timeline',
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
      ai_stalled: "couldn't be checked by AI",
      ai_resumed: 'could be checked by AI again',
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
    navGroups: {
      you: 'You',
      study: 'Study',
      app: 'App',
      system: 'System',
    },
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
    search: {
      placeholder: 'Search settings',
      ariaLabel: 'Search settings',
      clearAriaLabel: 'Clear search',
      noResults: 'No settings match.',
      resultCount: (n: number) =>
        n === 1 ? '1 setting matches' : `${n} settings match`,
    },
    searchKeywords: {
      identity: [
        'name',
        'display name',
        'public key',
        'recovery phrase',
        'friends backup',
        'restore',
      ],
      friends: [
        'manage',
        'remove',
        'pair',
        'safety number',
        'verify',
        'public key',
        'online',
        'last seen',
        'study time',
      ],
      sessions: ['history', 'past', 'report', 'review', 'delete'],
      stats: [
        'statistics',
        'dashboard',
        'streak',
        'focus',
        'partners',
        'insights',
        'export',
        'csv',
      ],
      appearance: [
        'theme',
        'dark',
        'light',
        'mode',
        'reduce motion',
        'window',
        'size',
        'position',
        'chrome',
        'title bar',
      ],
      notifications: [
        'invite',
        'pomodoro',
        'sound',
        'friend online',
        'alerts',
        'tray',
        'minimize',
      ],
      shortcuts: [
        'keybindings',
        'push to talk',
        'ptt',
        'accelerator',
        'hotkey',
      ],
      ai: [
        'focus detection',
        'model',
        'engine',
        'llama',
        'hardware',
        'gpu',
        'egpu',
        'cpu',
        'threshold',
        'warning',
        'alert',
        'confidence',
        'sample interval',
        'on-device',
        'capture displays',
        'multi-monitor',
        'screens',
      ],
      network: ['relay', 'turn', 'signaling', 'connection', 'diagnostics'],
      advanced: [
        'debug log',
        'log',
        'diagnostics',
        'autostart',
        'launch at login',
        'startup',
        'data folder',
        'replay onboarding',
        'clear history',
        'share log',
      ],
      about: [
        'version',
        'license',
        'github',
        'releases',
        'update',
        'auto-update',
        'automatic updates',
      ],
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
        help: "Your 24 words were shown once during setup and never saved — keep the original safe. Lost words can't be recovered; you'd start fresh and pair with your friends again.",
        restoreCta: 'Restore a different identity',
      },
      friendsBackup: {
        label: 'Friends backup',
        help: 'Your 24 words restore your identity, but not your friends list. Save an encrypted copy to keep alongside them — only this identity can open it.',
        exportCta: 'Export friends',
        exportAriaLabel: 'Export friends to an encrypted backup file',
        importCta: 'Import friends',
        importAriaLabel: 'Import friends from a backup file',
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
      detail: {
        toggleCta: 'Details',
        showAriaLabel: (name: string) => `Show details for ${name}`,
        hideAriaLabel: (name: string) => `Hide details for ${name}`,
        statusLabel: 'Status',
        safetyNumberLabel: 'Safety number',
        safetyNumberHelp:
          'Read these digits aloud on a call or in person. Matching on both screens means no one has swapped keys on you since you paired.',
        safetyNumberPending: 'Loading your identity…',
        safetyNumberCopyAriaLabel: (name: string) =>
          `Copy the safety number for ${name}`,
        publicKeyLabel: 'Public key',
        publicKeyHelp: "Your friend's identity key. Safe to share.",
        publicKeyCopyAriaLabel: (name: string) =>
          `Copy the public key for ${name}`,
        addedLabel: 'Added',
        addedUnknown: 'Unknown',
        studiedLabel: 'Studied together',
        studiedNone: 'No sessions together yet',
        studiedSummary: (sessions: string, duration: string) =>
          `${sessions} · ${duration}`,
        studiedSessions: (n: number) =>
          `${n} ${n === 1 ? 'session' : 'sessions'}`,
        durationMinutes: (n: number) => `${n} min`,
        durationHours: (h: number, m: number) =>
          m === 0 ? `${h} h` : `${h} h ${m} min`,
        studiedLoading: 'Reading your session history…',
        studiedError: "Couldn't read your session history.",
        lastTogetherLabel: 'Last together',
      },
    },

    sessions: {
      heading: 'Sessions',
      loadErrorLabel: "Couldn't load session history.",
      loadErrorHelp:
        'Something went wrong reading your local data. Retrying usually fixes it; restarting StudyVis helps if it keeps happening.',
      emptyLabel: 'No sessions yet',
      emptyHelp: 'Finish a session to see its report here.',
      loadingAriaLabel: 'Loading sessions',
      missing: '—',
      meta: {
        solo: 'solo',
        oneFriend: '1 friend',
        manyFriends: (n: number) => `${n} friends`,
        minutes: (n: number) => `${n} min`,
        score: (n: number) => `${n} / 100`,
        unknown: 'Details unavailable',
        notMeasured: 'not measured',
      },
      review: {
        cta: 'View report',
        ariaLabel: (ordinal: number, when: string) =>
          `View report for session ${ordinal} from ${when}`,
        backCta: 'Back to sessions',
      },
      delete: {
        cta: 'Delete',
        ariaLabel: (ordinal: number, when: string) =>
          `Delete session ${ordinal} from ${when}`,
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
      window: {
        heading: 'Window',
        remember: {
          label: 'Remember size and position',
          help: 'Reopens the window where you left it.',
          ariaLabel: 'Remember window size and position',
        },
        reset: {
          label: 'Window size',
          help: 'Back to the default size, centered on your screen.',
          resetCta: 'Reset',
          resetAriaLabel: 'Reset window size and position',
          resetToast: 'Window size reset.',
          resetError: "Couldn't reset the window size.",
        },
      },
    },

    notifications: {
      heading: 'Notifications',
      systemPermission: {
        checkingAriaLabel: 'Checking notification permission',
        label: 'System permission',
        grantedHelp: 'Your system is allowing StudyVis notifications.',
        grantedBadge: 'Allowed',
        deniedHelp:
          "Your system is blocking StudyVis notifications, so none of the alerts below will appear — even when they're switched on.",
        requestCta: 'Request permission',
        openSettingsCta: 'Open system settings',
        stillDenied:
          'Still blocked. Allow StudyVis under your system notification settings, then come back.',
        openErrorFallback: "Couldn't open your system's notification settings.",
      },
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
      pomodoro: {
        label: 'Pomodoro break notifications',
        help: "OS prompt when your focus block flips to a break, and back. Skipped while you're looking at the timer.",
        ariaLabel: 'Pomodoro break notifications',
      },
      pomodoroSound: {
        label: 'Pomodoro chime',
        help: 'Plays a short, quiet chime when your focus block flips to a break, and back. Off by default.',
        ariaLabel: 'Pomodoro chime',
      },
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
        resetError: (message: string) =>
          `Couldn't reset both shortcuts: ${message}`,
      },
    },

    ai: {
      heading: 'AI',
      intro:
        'The vision model runs on this machine and only looks at your camera and screen — none of that ever leaves your computer. Downloading a model or the engine fetches files from the internet; nothing about you is sent.',
      screenIndicatorNote:
        "While the AI is sampling, your operating system's screen-recording indicator stays on for the whole session. That's expected — it turns off when you leave. On macOS, screen-recording access is granted and revoked only in System Settings → Privacy & Security → Screen Recording; StudyVis can open it for you when needed.",
      enable: {
        label: 'Enable AI features',
        help: "Off by default. Model setup and benchmarks stay available while AI is off. We'll ask for screen access when you turn AI on.",
        ariaLabel: 'Enable AI features',
        loadingToast:
          'Model settings are still loading. Try again in a moment.',
        modelErrorToast:
          "Couldn't read your model settings. Reopen Settings and try again.",
        pickModelFirstToast:
          'Download and choose a model before turning AI on.',
        benchmarkBusyToast:
          'Wait for the current model setup or benchmark to finish before turning AI on.',
      },
      modelOff: {
        label: 'AI is off',
        help: 'No camera or screen checks are running. You can still download, choose, and benchmark a model below.',
      },
      benchmarkWarning: {
        title: 'Benchmark this model first?',
        fallbackModelName: 'Your selected model',
        description: (displayName: string, fallbackSec: number) =>
          `${displayName} can run without a benchmark. Until you measure it, StudyVis uses a ${fallbackSec}-second sampling interval, allows extra time for each result, and skips automatic slowdown tuning.`,
        recommendation:
          'Benchmarking is recommended for timing tuned to this computer, but it is not required.',
        keepOffCta: 'Keep AI off',
        benchmarkFirstCta: 'Benchmark first',
        enableAnywayCta: 'Turn on anyway',
      },
      sampleInterval: {
        label: 'Sample interval',
        helpMeasured: (measuredFloor: number, max: number) =>
          `How often the model looks (seconds). The floor is what this machine measured (${measuredFloor}s); you can only slow it down, up to ${max}s. Takes effect on the next sample.`,
        helpDefault: (fallbackFloor: number, max: number) =>
          `How often the model looks (seconds). Until you benchmark it, the model uses a ${fallbackFloor}s floor; you can slow it down up to ${max}s. Takes effect on the next sample.`,
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
      confidenceFloor: {
        label: 'Off-task sensitivity',
        help: 'Higher counts more of the model’s off-task calls against you (more flags). Lower skips the calls the model only half-doubts, so only confident off-task moments count (fewer false alarms). Skipped samples are never held against you.',
        ariaLabel: 'Off-task sensitivity',
      },
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
        label: 'Mirror AI diagnostics to console',
        help: 'Per-sample AI detail is always saved to the local diagnostic log. Turn this on to mirror it to the developer console. Same setting as Advanced → Developer console.',
        ariaLabel: 'Mirror AI diagnostics to the developer console',
      },
      hfToken: {
        label: 'Hugging Face token',
        help: 'Stored in your OS keychain for gated model downloads. None of the current catalog needs one — kept for gated models a future update may add. Forgetting it does not delete already-downloaded models.',
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
      engine: {
        label: 'AI engine',
        helpBundled: (version: string) =>
          `llama.cpp ${version} — included with this build.`,
        helpManaged: (version: string) =>
          `llama.cpp ${version} — downloaded automatically.`,
        helpMissingAuto:
          "Not installed yet. It'll download automatically when AI starts.",
        helpMissingManual: 'Not installed.',
        helpUnsupported: 'No prebuilt engine for this computer yet.',
        helpInstallError: (error: string) => `Couldn't install: ${error}`,
        helpDownloading: (received: string, total: string) =>
          `Downloading the engine — ${received} of ${total}.`,
        helpDownloadingIndeterminate: (received: string) =>
          `Downloading the engine — ${received} so far.`,
        helpVerifying: 'Checking the download.',
        helpExtracting: 'Unpacking the engine.',
        installCta: 'Install now',
        reinstallCta: 'Reinstall',
        installedToast: 'AI engine installed.',
        installErrorFallback: "Couldn't install the AI engine.",
        installAria: 'Install the AI engine',
        auto: {
          label: 'Install engine automatically',
          help: "Fetches the pinned llama.cpp engine from GitHub if it's ever missing when AI starts. Size varies by platform and every download is checksum-verified.",
          ariaLabel: 'Install engine automatically',
        },
      },
      computeDevice: {
        label: 'AI hardware',
        ariaLabel: 'AI compute hardware',
        helpSaveError:
          "Couldn't save that hardware choice. Your previous choice is still active.",
        helpDetectionFailed:
          'Hardware detection failed. Automatic and CPU remain available; reinstall the AI engine if accelerator detection keeps failing.',
        helpEngineMissing:
          'Install the AI engine to detect GPUs. Automatic and CPU are always available.',
        helpUnavailable:
          'That accelerator is not currently available. StudyVis keeps your choice instead of silently switching hardware.',
        helpNoAccelerator:
          'No accelerator was reported by the AI engine. Automatic will fall back to CPU.',
        help:
          'Choose where local AI inference runs. Automatic uses available acceleration; changing this makes existing model benchmarks stale.',
        optionAuto: 'Automatic (recommended)',
        optionCpu: 'CPU',
        optionUnavailable: (deviceId: string) => `Unavailable — ${deviceId}`,
      },
      permissions: {
        grantedToast: 'Screen recording granted.',
        requestErrorFallback: "Couldn't request access.",
        pickModelFirstBody:
          'Pick and download a model now. StudyVis asks for screen access when AI is on — your OS recording indicator will stay lit for the whole session.',
      },
    },

    network: {
      heading: 'Network',
      about: {
        label: 'About connections',
        help: 'StudyVis connects you to friends directly. If a strict network (corporate firewall, locked-down Wi-Fi) blocks that, add your own TURN relay below — traffic stays end-to-end encrypted either way.',
      },
      preference: {
        label: 'TURN preference',
        help: 'Only takes effect once you add a TURN server below; with none configured, every option is direct-only.',
        ariaLabel: 'TURN preference',
        options: {
          auto: 'Auto (use TURN when direct fails)',
          always: 'Always route through TURN',
          never: 'Never use TURN',
        },
      },
      diagnostics: {
        label: 'Connection',
        help: 'Live status of the signaling relays StudyVis uses to find your friends. This is a local read — nothing is sent anywhere.',
        empty: 'No relay connections yet. They open a moment after launch.',
        transport: {
          nostr: 'Nostr relays',
          mqtt: 'MQTT brokers',
        },
        status: {
          connected: 'Connected',
          connecting: 'Connecting…',
          down: 'Not connected',
        },
        dotAriaLabel: (url: string, status: string) => `${url}: ${status}`,
      },
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
          help: 'A TURN relay gets you through strict firewalls and NATs. Self-host coturn, or use a provider. All three fields are required to enable it. Sessions, pairing, and invites use it right away; presence and invite delivery pick it up after a restart.',
          urlLabel: 'TURN URL',
          urlPlaceholder: 'turn:turn.example.com:3478',
          urlAriaLabel: 'TURN server URL',
          usernameLabel: 'Username',
          usernameAriaLabel: 'TURN username',
          credentialLabel: 'Password',
          credentialAriaLabel: 'TURN password',
          invalidUrl: 'TURN URL must start with turn: or turns:',
          active: 'TURN server active — the preference above now applies.',
          test: {
            cta: 'Test connection',
            testing: `Testing${'…'}`,
            ariaLabel: 'Test the TURN server connection',
            success: (seconds: string) =>
              `Relay candidate gathered in ${seconds}s — your TURN server works from this network.`,
            timeout:
              'No relay candidate within 10 seconds. Check the URL and that the server is reachable from this network.',
            noRelay:
              'The server answered but allocated no relay — this usually means the username or password is wrong.',
            errorFallback: "Couldn't run the test on this device.",
          },
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
        label: 'Developer console',
        help: 'Verbose diagnostic detail is always saved to the local log. Turn this on to mirror info and debug records to the developer console. Off by default; persists across launches.',
        ariaLabel: 'Mirror verbose diagnostics to the developer console',
      },
      dataFolder: {
        label: 'Open data folder',
        help: 'Reveals the directory holding your local SQLite database and identity record.',
        openCta: 'Open',
        errorFallback: "Couldn't open the data folder.",
      },
      shareLog: {
        label: 'Diagnostics',
        help: 'Download a ZIP with recent StudyVis and local AI-engine logs, copy a short app summary, or open the log folder. Nothing is uploaded — review the files and choose what to share.',
        copyCta: 'Copy diagnostics',
        revealCta: 'Open log',
        copiedToast: 'Diagnostics copied to the clipboard.',
        copyError: "Couldn't copy the diagnostics.",
        revealError: "Couldn't open the log file.",
        summary: (v: {
          version: string
          os: string
          arch: string
          webview: string
          display: string
          logPath: string
          aiLogPath: string
          logTail: string
        }) =>
          `StudyVis ${v.version}\nOS: ${v.os} (${v.arch})\nWebview: ${v.webview}\nDisplay: ${v.display}\nLog: ${v.logPath}\nAI log: ${v.aiLogPath}\n\nRecent log:\n${v.logTail}`,
      },
      replayOnboarding: {
        label: 'Replay onboarding',
        help: 'Restarts the welcome → permissions → tutorial flow from the beginning. Your identity and friends are kept.',
        replayCta: 'Replay',
        scheduledToast: 'Onboarding will play on the next launch.',
      },
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
        help: 'Release notes for every version, and installers if you ever need one by hand.',
        openCta: 'Open',
        errorFallback: "Couldn't open the Releases page.",
      },
      autoUpdate: {
        label: 'Automatic updates',
        help: 'StudyVis checks GitHub for new releases, downloads them in the background, and installs on restart. It sends no data about you. Turn this off and nothing goes out.',
        ariaLabel: 'Automatic updates',
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
      coverage: (scored: number, total: number) =>
        `From ${scored} of ${total} ${total === 1 ? 'session' : 'sessions'}`,
      limitedData: 'Limited data',
    },
    studyMinutes: {
      heading: 'Study minutes · last 30 days',
      minutes: (n: number) => `${n} ${n === 1 ? 'minute' : 'minutes'}`,
    },
    heatmap: {
      heading: 'Your year of studying',
      help: 'One square per day, darker for a longer day. Hover a square for the date.',
      ariaLabel: (daysStudied: number, days: number) =>
        `Study heatmap: ${daysStudied} of the last ${days} days studied`,
      empty: 'Nothing on the calendar yet. Your first session fills a square.',
      cell: (day: string, minutes: number) =>
        `${day} · ${minutes === 0 ? 'no study' : `${minutes} min`}`,
      legend: {
        less: 'Less',
        more: 'More',
        level: (from: number, to: number | null) =>
          to === null ? `${from}+ min` : `${from}–${to} min`,
        none: 'No study',
      },
      weekdays: {
        monday: 'Mon',
        wednesday: 'Wed',
        friday: 'Fri',
      },
      stats: {
        daysStudied: 'Days studied',
        daysStudiedOf: (days: number) => `Out of the last ${days}`,
        hours: 'Hours studied',
        hoursHelp: 'Across the same year',
        longestStreak: 'Longest streak',
        longestStreakHelp: 'Best run of days in a row, all time',
        days: (n: number) => (n === 1 ? 'day' : 'days'),
        hoursUnit: (n: number) => (n === 1 ? 'hour' : 'hours'),
      },
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
      body: 'Download, choose, and benchmark separately. Benchmarking is recommended for tuned timing, but it is not required. The model runs only on this machine.',
      lockedDuringSession:
        'Model changes are locked while AI is running in this session. Turn AI off or wait until the session ends.',
      engineMissing: 'Install the AI engine first (see the AI engine row).',
      staleBenchmark:
        'Measured on an older StudyVis — re-run the benchmark for current numbers.',
      benchmarkWhileAiEnabled:
        'Turn AI off before benchmarking. This keeps the benchmark from sharing the model process with live focus checks.',
      modelChangesWhileAiRunning:
        'Turn AI off or wait until the session ends before changing models.',
      pills: {
        gated: 'Gated',
        installed: 'Installed',
        active: 'In use',
        incomplete: 'Incomplete',
      },
      quantPicker: {
        legend: 'Quantization',
        ariaLabel: (model: string) => `${model} quantization`,
        installedSuffix: ' · installed',
        activeSuffix: ' · in use',
      },
      dataLabels: {
        download: 'Download',
        ram: 'RAM',
        license: 'License',
        quant: 'Quant',
      },
      cancelCta: 'Cancel',
      useModelCta: 'Use model',
      benchmarkCta: 'Benchmark',
      reBenchmarkCta: 'Re-benchmark',
      reDownloadCta: 'Re-download',
      downloadCta: 'Download',
      resumeCta: 'Resume download',
      resumeNote: (received: string) =>
        `Picks up from where it stopped (${received} downloaded).`,
      removeAriaLabel: (name: string) => `Remove ${name}`,
      notBenchmarked:
        'Not benchmarked. You can still use this model; StudyVis will use safe default timing.',
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
        removing: `Removing model${ELLIPSIS}`,
        cancelling: `Cancelling${ELLIPSIS}`,
        failedFallback: 'Something went wrong.',
      },
      readyToast: (displayName: string, p95Sec: number) =>
        `${displayName} ready. Speed on your machine: ${p95Sec.toFixed(1)} s/check.`,
      installedAndSelectedToast: (displayName: string) =>
        `${displayName} installed and selected. Benchmark it for timing tuned to this computer.`,
      installedToast: (displayName: string) =>
        `${displayName} installed. Choose Use model when you're ready.`,
      selectedToast: (displayName: string) => `${displayName} is now in use.`,
      selectUnbenchmarkedTurnAiOff:
        'Turn AI off before choosing an unbenchmarked model. You can turn it back on and choose whether to benchmark first.',
      removeActiveTurnAiOff:
        'Turn AI off before removing the model currently in use.',
      selectErrorToast: (displayName: string, message: string) =>
        `Couldn't use ${displayName}: ${message}`,
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
      body: "Smaller models run faster and use less RAM but describe the screen in less detail. Bigger models catch subtler off-task behavior. Benchmarking is optional; measured numbers appear below after you run it, and dashes are tiers you haven't measured yet.",
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
      sidecarOff: "AI isn't ready yet. Check Settings → AI, then try again.",
      timeout: 'The assistant took too long.',
      httpStatus: (status: number) => `The assistant returned HTTP ${status}.`,
      parseFallback: "I didn't catch that. Say it another way?",
      topicUpdated: (topic: string) => `Topic updated to ${topic}.`,
      considering: (minutes: number) => `Considering a ${minutes}-min break.`,
      noReply: '(no reply)',
    },
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
    },
    pomodoro: {
      breakTitle: 'Time for a break',
      breakBody: 'Step away and rest your eyes for a bit.',
      workTitle: 'Back to work',
      workBody: 'Break over — settle back into your focus block.',
    },
    friendOnline: {
      title: 'StudyVis',
      body: (name: string) => `${name} is now online`,
    },
  },

  updater: {
    banner: {
      ariaLabel: 'Update ready',
      title: (version: string) => `StudyVis ${version} is ready`,
      body: 'Downloaded and verified. Restart to finish — it takes a couple of seconds.',
      restartCta: 'Restart now',
      laterCta: 'Later',
      dismissAriaLabel: 'Dismiss until next launch',
      notesCta: 'Release notes',
      installing: 'Installing…',
      blockedAriaLabel: 'Update available — a move to Applications is needed',
      blockedTitle: (version: string) => `StudyVis ${version} is available`,
      blockedBody:
        "StudyVis can't update itself from where it's running — usually the installer disk image. Quit StudyVis, drag it into Applications (replacing any old copy), and open it from there. Updates take care of themselves after that.",
      blockedDismissCta: 'Got it',
      blockedDismissAriaLabel: 'Dismiss until next launch',
    },
    settings: {
      readyLabel: 'Update ready',
      readyHelp: (version: string) =>
        `Version ${version} is downloaded and waiting. Restart to finish.`,
      blockedLabel: 'Update available',
      blockedHelp: (version: string) =>
        `Version ${version} is out, but StudyVis can't update itself from where it's running — usually the installer disk image. Quit, drag StudyVis into Applications, and open it from there.`,
      downloadingLabel: 'Downloading update',
      downloadingHelp: (version: string, percent: number) =>
        `Version ${version} — ${percent}%`,
      checkingHelp: 'Checking for updates…',
      upToDateHelp: (version: string) => `You're on ${version}, the latest.`,
      statusLabel: 'Updates',
      lastCheckFailedHelp:
        "The last update check didn't finish. Press Check now to retry.",
      unknownHelp: 'Update status unknown — press Check now.',
      checkCta: 'Check now',
      restartCta: 'Restart now',
      lockedDuringSession: (version: string) =>
        `Version ${version} is downloaded and waiting — updating restarts StudyVis, so it unlocks after your session ends.`,
      checkLockedDuringSession:
        'Update checks pause during a session so the download stays off your call.',
    },
    errors: {
      checkFailed: "Couldn't reach GitHub to check for updates.",
      downloadFailed:
        "Couldn't download the update. StudyVis will retry later.",
      installFailed:
        "Couldn't install the update. Download the installer from the Releases page instead.",
    },
  },

  errors: {
    leaveSessionFirst: 'Leave the current session before joining another.',
  },
} as const
