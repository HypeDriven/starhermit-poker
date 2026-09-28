// Strings for the Settings → Graphics panel. The rest of the game is English
// only; this panel follows the browser language (navigator.language), with
// a language-prefix fallback and en-US as the last resort.

const en = {
  settings: 'Settings',
  openSettings: 'Open settings',
  close: 'Close',
  graphics: 'Graphics',
  quality: 'Quality',
  auto: (tier) => `Auto (detected: ${tier})`,
  preset_low: 'Low', preset_balanced: 'Balanced', preset_high: 'High', preset_ultra: 'Ultra',
  renderScale: 'Render scale',
  fromPreset: (tier) => `From preset (${tier})`,
  cat_shadows: 'Shadows', cat_ao: 'Ambient occlusion', cat_bloom: 'Bloom',
  cat_grade: 'Color grade', cat_antialias: 'Anti-aliasing', cat_reflections: 'Reflections',
  cat_detail: 'Table detail', cat_particles: 'Particles', cat_background: 'Background',
  tier_off: 'Off', tier_on: 'On', tier_low: 'Low', tier_medium: 'Medium', tier_high: 'High',
  tier_fxaa: 'FXAA', tier_smaa: 'SMAA', tier_msaa: 'MSAA',
  tier_static: 'Static', tier_animated: 'Animated', tier_plain: 'Plain', tier_detailed: 'Detailed',
  adaptive: 'Adaptive resolution',
  adaptiveHint: 'Lowers the resolution when frames are slow',
  showFps: 'Show frame rate',
  postFailed: 'Post-processing is unavailable on this device; effects are rendered without it.',
  unknownGpu: 'unknown GPU',
  noShadows: 'no shadows', shadows: (n) => `${n}² shadows`, ao: 'ambient occlusion',
  aoHigh: 'full ambient occlusion', bloom: 'bloom', reflections: 'reflections', noAa: 'no anti-aliasing',
};

const STRINGS = {
  'en-US': en,
  'en-GB': { ...en, cat_grade: 'Colour grade' },
  'es-419': {
    settings: 'Configuración', openSettings: 'Abrir configuración', close: 'Cerrar',
    graphics: 'Gráficos', quality: 'Calidad',
    auto: (tier) => `Automática (detectada: ${tier})`,
    preset_low: 'Baja', preset_balanced: 'Equilibrada', preset_high: 'Alta', preset_ultra: 'Ultra',
    renderScale: 'Escala de renderizado',
    fromPreset: (tier) => `Según el ajuste (${tier})`,
    cat_shadows: 'Sombras', cat_ao: 'Oclusión ambiental', cat_bloom: 'Resplandor',
    cat_grade: 'Corrección de color', cat_antialias: 'Antialiasing', cat_reflections: 'Reflejos',
    cat_detail: 'Detalle de la mesa', cat_particles: 'Partículas', cat_background: 'Fondo',
    tier_off: 'Desactivado', tier_on: 'Activado', tier_low: 'Bajo', tier_medium: 'Medio', tier_high: 'Alto',
    tier_static: 'Estático', tier_animated: 'Animado', tier_plain: 'Simple', tier_detailed: 'Detallado',
    adaptive: 'Resolución adaptativa',
    adaptiveHint: 'Reduce la resolución cuando los cuadros van lentos',
    showFps: 'Mostrar cuadros por segundo',
    postFailed: 'El posprocesamiento no está disponible en este dispositivo; los efectos se muestran sin él.',
    unknownGpu: 'GPU desconocida',
    noShadows: 'sin sombras', shadows: (n) => `sombras ${n}²`, ao: 'oclusión ambiental',
    aoHigh: 'oclusión ambiental completa', bloom: 'resplandor', reflections: 'reflejos', noAa: 'sin antialiasing',
  },
  'es-ES': {
    settings: 'Ajustes', openSettings: 'Abrir ajustes', close: 'Cerrar',
    graphics: 'Gráficos', quality: 'Calidad',
    auto: (tier) => `Automática (detectada: ${tier})`,
    preset_low: 'Baja', preset_balanced: 'Equilibrada', preset_high: 'Alta', preset_ultra: 'Ultra',
    renderScale: 'Escala de renderizado',
    fromPreset: (tier) => `Según el ajuste (${tier})`,
    cat_shadows: 'Sombras', cat_ao: 'Oclusión ambiental', cat_bloom: 'Resplandor',
    cat_grade: 'Corrección de color', cat_antialias: 'Suavizado de bordes', cat_reflections: 'Reflejos',
    cat_detail: 'Detalle de la mesa', cat_particles: 'Partículas', cat_background: 'Fondo',
    tier_off: 'Desactivado', tier_on: 'Activado', tier_low: 'Bajo', tier_medium: 'Medio', tier_high: 'Alto',
    tier_static: 'Estático', tier_animated: 'Animado', tier_plain: 'Sencillo', tier_detailed: 'Detallado',
    adaptive: 'Resolución adaptativa',
    adaptiveHint: 'Baja la resolución cuando los fotogramas van lentos',
    showFps: 'Mostrar fotogramas por segundo',
    postFailed: 'El posprocesado no está disponible en este dispositivo; los efectos se muestran sin él.',
    unknownGpu: 'GPU desconocida',
    noShadows: 'sin sombras', shadows: (n) => `sombras ${n}²`, ao: 'oclusión ambiental',
    aoHigh: 'oclusión ambiental completa', bloom: 'resplandor', reflections: 'reflejos', noAa: 'sin suavizado',
  },
  'de-DE': {
    settings: 'Einstellungen', openSettings: 'Einstellungen öffnen', close: 'Schließen',
    graphics: 'Grafik', quality: 'Qualität',
    auto: (tier) => `Automatisch (erkannt: ${tier})`,
    preset_low: 'Niedrig', preset_balanced: 'Ausgewogen', preset_high: 'Hoch', preset_ultra: 'Ultra',
    renderScale: 'Renderskalierung',
    fromPreset: (tier) => `Aus Voreinstellung (${tier})`,
    cat_shadows: 'Schatten', cat_ao: 'Umgebungsverdeckung', cat_bloom: 'Bloom',
    cat_grade: 'Farbkorrektur', cat_antialias: 'Kantenglättung', cat_reflections: 'Reflexionen',
    cat_detail: 'Tischdetails', cat_particles: 'Partikel', cat_background: 'Hintergrund',
    tier_off: 'Aus', tier_on: 'An', tier_low: 'Niedrig', tier_medium: 'Mittel', tier_high: 'Hoch',
    tier_static: 'Statisch', tier_animated: 'Animiert', tier_plain: 'Einfach', tier_detailed: 'Detailliert',
    adaptive: 'Adaptive Auflösung',
    adaptiveHint: 'Senkt die Auflösung, wenn Bilder langsam sind',
    showFps: 'Bildrate anzeigen',
    postFailed: 'Nachbearbeitung ist auf diesem Gerät nicht verfügbar; es wird ohne sie gerendert.',
    unknownGpu: 'unbekannte GPU',
    noShadows: 'keine Schatten', shadows: (n) => `${n}²-Schatten`, ao: 'Umgebungsverdeckung',
    aoHigh: 'volle Umgebungsverdeckung', bloom: 'Bloom', reflections: 'Reflexionen', noAa: 'keine Kantenglättung',
  },
  'fr-FR': {
    settings: 'Paramètres', openSettings: 'Ouvrir les paramètres', close: 'Fermer',
    graphics: 'Graphismes', quality: 'Qualité',
    auto: (tier) => `Auto (détectée : ${tier})`,
    preset_low: 'Basse', preset_balanced: 'Équilibrée', preset_high: 'Haute', preset_ultra: 'Ultra',
    renderScale: 'Échelle de rendu',
    fromPreset: (tier) => `Selon le préréglage (${tier})`,
    cat_shadows: 'Ombres', cat_ao: 'Occlusion ambiante', cat_bloom: 'Flou lumineux',
    cat_grade: 'Étalonnage des couleurs', cat_antialias: 'Anticrénelage', cat_reflections: 'Reflets',
    cat_detail: 'Détails de la table', cat_particles: 'Particules', cat_background: 'Arrière-plan',
    tier_off: 'Désactivé', tier_on: 'Activé', tier_low: 'Bas', tier_medium: 'Moyen', tier_high: 'Élevé',
    tier_static: 'Statique', tier_animated: 'Animé', tier_plain: 'Simple', tier_detailed: 'Détaillé',
    adaptive: 'Résolution adaptative',
    adaptiveHint: 'Baisse la résolution quand les images ralentissent',
    showFps: 'Afficher la fréquence d’images',
    postFailed: 'Le post-traitement n’est pas disponible sur cet appareil ; le rendu se fait sans lui.',
    unknownGpu: 'GPU inconnu',
    noShadows: 'sans ombres', shadows: (n) => `ombres ${n}²`, ao: 'occlusion ambiante',
    aoHigh: 'occlusion ambiante complète', bloom: 'flou lumineux', reflections: 'reflets', noAa: 'sans anticrénelage',
  },
  'fr-CA': {
    settings: 'Paramètres', openSettings: 'Ouvrir les paramètres', close: 'Fermer',
    graphics: 'Graphiques', quality: 'Qualité',
    auto: (tier) => `Auto (détectée : ${tier})`,
    preset_low: 'Basse', preset_balanced: 'Équilibrée', preset_high: 'Haute', preset_ultra: 'Ultra',
    renderScale: 'Échelle de rendu',
    fromPreset: (tier) => `Selon le préréglage (${tier})`,
    cat_shadows: 'Ombres', cat_ao: 'Occlusion ambiante', cat_bloom: 'Halo lumineux',
    cat_grade: 'Correction des couleurs', cat_antialias: 'Anticrénelage', cat_reflections: 'Reflets',
    cat_detail: 'Détails de la table', cat_particles: 'Particules', cat_background: 'Arrière-plan',
    tier_off: 'Désactivé', tier_on: 'Activé', tier_low: 'Bas', tier_medium: 'Moyen', tier_high: 'Élevé',
    tier_static: 'Statique', tier_animated: 'Animé', tier_plain: 'Simple', tier_detailed: 'Détaillé',
    adaptive: 'Résolution adaptative',
    adaptiveHint: 'Réduit la résolution quand les images ralentissent',
    showFps: 'Afficher la fréquence d’images',
    postFailed: 'Le post-traitement n’est pas offert sur cet appareil; le rendu se fait sans lui.',
    unknownGpu: 'GPU inconnu',
    noShadows: 'sans ombres', shadows: (n) => `ombres ${n}²`, ao: 'occlusion ambiante',
    aoHigh: 'occlusion ambiante complète', bloom: 'halo lumineux', reflections: 'reflets', noAa: 'sans anticrénelage',
  },
  'pt-BR': {
    settings: 'Configurações', openSettings: 'Abrir configurações', close: 'Fechar',
    graphics: 'Gráficos', quality: 'Qualidade',
    auto: (tier) => `Automática (detectada: ${tier})`,
    preset_low: 'Baixa', preset_balanced: 'Equilibrada', preset_high: 'Alta', preset_ultra: 'Ultra',
    renderScale: 'Escala de renderização',
    fromPreset: (tier) => `Da predefinição (${tier})`,
    cat_shadows: 'Sombras', cat_ao: 'Oclusão ambiente', cat_bloom: 'Brilho',
    cat_grade: 'Correção de cor', cat_antialias: 'Antisserrilhado', cat_reflections: 'Reflexos',
    cat_detail: 'Detalhes da mesa', cat_particles: 'Partículas', cat_background: 'Fundo',
    tier_off: 'Desligado', tier_on: 'Ligado', tier_low: 'Baixo', tier_medium: 'Médio', tier_high: 'Alto',
    tier_static: 'Estático', tier_animated: 'Animado', tier_plain: 'Simples', tier_detailed: 'Detalhado',
    adaptive: 'Resolução adaptativa',
    adaptiveHint: 'Reduz a resolução quando os quadros ficam lentos',
    showFps: 'Mostrar taxa de quadros',
    postFailed: 'O pós-processamento não está disponível neste dispositivo; os efeitos são exibidos sem ele.',
    unknownGpu: 'GPU desconhecida',
    noShadows: 'sem sombras', shadows: (n) => `sombras ${n}²`, ao: 'oclusão ambiente',
    aoHigh: 'oclusão ambiente completa', bloom: 'brilho', reflections: 'reflexos', noAa: 'sem antisserrilhado',
  },
  'it-IT': {
    settings: 'Impostazioni', openSettings: 'Apri impostazioni', close: 'Chiudi',
    graphics: 'Grafica', quality: 'Qualità',
    auto: (tier) => `Automatica (rilevata: ${tier})`,
    preset_low: 'Bassa', preset_balanced: 'Bilanciata', preset_high: 'Alta', preset_ultra: 'Ultra',
    renderScale: 'Scala di rendering',
    fromPreset: (tier) => `Dal predefinito (${tier})`,
    cat_shadows: 'Ombre', cat_ao: 'Occlusione ambientale', cat_bloom: 'Bagliore',
    cat_grade: 'Correzione colore', cat_antialias: 'Antialiasing', cat_reflections: 'Riflessi',
    cat_detail: 'Dettagli del tavolo', cat_particles: 'Particelle', cat_background: 'Sfondo',
    tier_off: 'Disattivato', tier_on: 'Attivato', tier_low: 'Basso', tier_medium: 'Medio', tier_high: 'Alto',
    tier_static: 'Statico', tier_animated: 'Animato', tier_plain: 'Semplice', tier_detailed: 'Dettagliato',
    adaptive: 'Risoluzione adattiva',
    adaptiveHint: 'Abbassa la risoluzione quando i fotogrammi rallentano',
    showFps: 'Mostra frequenza fotogrammi',
    postFailed: 'La post-elaborazione non è disponibile su questo dispositivo; gli effetti sono resi senza.',
    unknownGpu: 'GPU sconosciuta',
    noShadows: 'senza ombre', shadows: (n) => `ombre ${n}²`, ao: 'occlusione ambientale',
    aoHigh: 'occlusione ambientale completa', bloom: 'bagliore', reflections: 'riflessi', noAa: 'senza antialiasing',
  },
};

export const LOCALES = Object.keys(STRINGS);

const PREFIX = { en: 'en-US', es: 'es-419', de: 'de-DE', fr: 'fr-FR', pt: 'pt-BR', it: 'it-IT' };

/** Best supported locale for a BCP-47 tag (exact, then es-MX → es-419 style regional fallbacks). */
export function pickLocale(tag) {
  const t = String(tag || '').trim();
  const exact = LOCALES.find((l) => l.toLowerCase() === t.toLowerCase());
  if (exact) return exact;
  const [lang, region = ''] = t.toLowerCase().split(/[-_]/);
  if (lang === 'es' && region && region !== 'es') return 'es-419';
  if (lang === 'fr' && region === 'ca') return 'fr-CA';
  if (lang === 'en' && ['gb', 'uk', 'ie', 'au', 'nz'].includes(region)) return 'en-GB';
  return PREFIX[lang] || 'en-US';
}

let current = null;

/** Strings for `locale` (default: the browser language), falling back to en-US key by key. */
export function strings(locale) {
  const loc = locale ? pickLocale(locale)
    : current || (current = pickLocale(typeof navigator !== 'undefined' ? navigator.language : 'en-US'));
  return { ...en, ...STRINGS[loc], locale: loc };
}

export { STRINGS };
