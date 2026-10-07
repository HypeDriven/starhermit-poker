// StarHermit Poker — strings for the StarHermit account controls (sign-in, invite,
// sign-out notice, session-expired relaunch), in the nine supported locales. Follows the browser
// language.

const EN_US = {
  signIn: "Sign in with StarHermit",
  invite: "Invite a friend",
  inviteCopied: "Invite link copied to the clipboard.",
  inviteFailed: "Copy this invite link: {link}",
  signedOut: "Signed out of StarHermit — progress keeps saving on this device.",
  expired: "Your StarHermit session has expired, so online play stopped. Go back to StarHermit to start a fresh session, or keep playing offline.",
  relaunch: "Back to StarHermit",
  relaunchFailed: "Could not open StarHermit — reopen the game from the StarHermit library.",
};

const STRINGS = {
  "en-US": EN_US,
  "en-GB": { ...EN_US },
  "es-419": {
    signIn: "Iniciar sesión con StarHermit",
    invite: "Invitar a un amigo",
    inviteCopied: "Enlace de invitación copiado al portapapeles.",
    inviteFailed: "Copia este enlace de invitación: {link}",
    signedOut: "Se cerró la sesión de StarHermit; el progreso se sigue guardando en este dispositivo.",
    expired: "Tu sesión de StarHermit venció y el juego en línea se detuvo. Vuelve a StarHermit para iniciar una sesión nueva o sigue jugando sin conexión.",
    relaunch: "Volver a StarHermit",
    relaunchFailed: "No se pudo abrir StarHermit: vuelve a abrir el juego desde la biblioteca de StarHermit.",
  },
  "es-ES": {
    signIn: "Iniciar sesión con StarHermit",
    invite: "Invitar a un amigo",
    inviteCopied: "Enlace de invitación copiado al portapapeles.",
    inviteFailed: "Copia este enlace de invitación: {link}",
    signedOut: "Se ha cerrado la sesión de StarHermit; el progreso se sigue guardando en este dispositivo.",
    expired: "Tu sesión de StarHermit ha caducado y el juego en línea se ha detenido. Vuelve a StarHermit para iniciar una sesión nueva o sigue jugando sin conexión.",
    relaunch: "Volver a StarHermit",
    relaunchFailed: "No se ha podido abrir StarHermit: vuelve a abrir el juego desde la biblioteca de StarHermit.",
  },
  "de-DE": {
    signIn: "Mit StarHermit anmelden",
    invite: "Freund einladen",
    inviteCopied: "Einladungslink in die Zwischenablage kopiert.",
    inviteFailed: "Kopiere diesen Einladungslink: {link}",
    signedOut: "Von StarHermit abgemeldet – der Fortschritt wird weiter auf diesem Gerät gespeichert.",
    expired: "Deine StarHermit-Sitzung ist abgelaufen, daher wurde das Online-Spiel beendet. Kehre zu StarHermit zurück, um eine neue Sitzung zu starten, oder spiele offline weiter.",
    relaunch: "Zurück zu StarHermit",
    relaunchFailed: "StarHermit konnte nicht geöffnet werden – starte das Spiel erneut aus der StarHermit-Bibliothek.",
  },
  "fr-FR": {
    signIn: "Se connecter avec StarHermit",
    invite: "Inviter un ami",
    inviteCopied: "Lien d’invitation copié dans le presse-papiers.",
    inviteFailed: "Copiez ce lien d’invitation : {link}",
    signedOut: "Déconnecté de StarHermit — la progression reste enregistrée sur cet appareil.",
    expired: "Votre session StarHermit a expiré et le jeu en ligne s’est arrêté. Retournez sur StarHermit pour ouvrir une nouvelle session, ou continuez à jouer hors ligne.",
    relaunch: "Retour à StarHermit",
    relaunchFailed: "Impossible d’ouvrir StarHermit : relancez le jeu depuis la bibliothèque StarHermit.",
  },
  "fr-CA": {
    signIn: "Se connecter avec StarHermit",
    invite: "Inviter un ami",
    inviteCopied: "Lien d’invitation copié dans le presse-papiers.",
    inviteFailed: "Copiez ce lien d’invitation : {link}",
    signedOut: "Déconnecté de StarHermit — la progression reste enregistrée sur cet appareil.",
    expired: "Votre session StarHermit a expiré et le jeu en ligne s’est arrêté. Retournez sur StarHermit pour ouvrir une nouvelle session, ou continuez à jouer hors ligne.",
    relaunch: "Retour à StarHermit",
    relaunchFailed: "Impossible d’ouvrir StarHermit : relancez le jeu à partir de la bibliothèque StarHermit.",
  },
  "pt-BR": {
    signIn: "Entrar com StarHermit",
    invite: "Convidar um amigo",
    inviteCopied: "Link de convite copiado para a área de transferência.",
    inviteFailed: "Copie este link de convite: {link}",
    signedOut: "Você saiu do StarHermit — o progresso continua salvo neste dispositivo.",
    expired: "Sua sessão do StarHermit expirou e o jogo online parou. Volte ao StarHermit para iniciar uma nova sessão ou continue jogando offline.",
    relaunch: "Voltar ao StarHermit",
    relaunchFailed: "Não foi possível abrir o StarHermit — abra o jogo novamente pela biblioteca do StarHermit.",
  },
  "it-IT": {
    signIn: "Accedi con StarHermit",
    invite: "Invita un amico",
    inviteCopied: "Link di invito copiato negli appunti.",
    inviteFailed: "Copia questo link di invito: {link}",
    signedOut: "Disconnesso da StarHermit: i progressi continuano a essere salvati su questo dispositivo.",
    expired: "La tua sessione StarHermit è scaduta e il gioco online si è interrotto. Torna su StarHermit per avviare una nuova sessione o continua a giocare offline.",
    relaunch: "Torna a StarHermit",
    relaunchFailed: "Impossibile aprire StarHermit: riapri il gioco dalla libreria di StarHermit.",
  },
};

export const PLATFORM_LOCALES = Object.keys(STRINGS);

/** Best supported locale for a BCP-47 tag or list of tags. */
export function pickPlatformLocale(tags) {
  const list = (Array.isArray(tags) ? tags : [tags]).filter(Boolean).map(String);
  for (const tag of list) {
    const t = tag.replace("_", "-");
    const exact = PLATFORM_LOCALES.find((l) => l.toLowerCase() === t.toLowerCase());
    if (exact) return exact;
    const [lang, region = ""] = t.split("-");
    const r = region.toUpperCase();
    switch (lang.toLowerCase()) {
      case "en": return r === "GB" || r === "UK" ? "en-GB" : "en-US";
      case "es": return r === "ES" ? "es-ES" : "es-419";
      case "fr": return r === "CA" ? "fr-CA" : "fr-FR";
      case "pt": return "pt-BR";
      case "de": return "de-DE";
      case "it": return "it-IT";
    }
  }
  return "en-US";
}

export function platformStrings(locale) {
  return STRINGS[locale] || EN_US;
}

/** Strings for the browser's language (or an explicit locale). */
export function currentPlatformStrings(locale) {
  if (locale) return platformStrings(pickPlatformLocale(locale));
  const langs = typeof navigator !== "undefined" ? (navigator.languages || [navigator.language]) : [];
  return platformStrings(pickPlatformLocale(langs));
}

/**
 * Local-menu additions after the SDK signed out ({ signedIn:false, reason }):
 * a notice, plus onRelaunch() (→ StarHermit.relaunch(), from a click) when the
 * session expired — only a fresh launch from StarHermit can mint a new token.
 */
export function signedOutMenu(auth, sh, locale) {
  const t = currentPlatformStrings(locale);
  if (auth && auth.reason === "expired" && sh && typeof sh.relaunch === "function") {
    return { notice: t.expired, onRelaunch: () => !!sh.relaunch() };
  }
  return { notice: t.signedOut };
}
