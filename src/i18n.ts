import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';

type Locale = 'es' | 'fr' | 'pt-BR';
type Params = Record<string, string | number>;

const namespace = 'pi-gitnexus';

const fallback = {
  'notify.active': 'GitNexus: knowledge graph active — searches will be enriched automatically.',
  'notify.missingBinary': 'GitNexus index found but gitnexus is not on PATH. Install: npm i -g gitnexus',
  'status.notInstalled': 'gitnexus is not installed. Install: npm i -g gitnexus',
  'status.noIndex': 'No GitNexus index found. Run: /gitnexus analyze',
  'analyze.start': 'GitNexus: analyzing codebase, this may take a while…',
  'analyze.complete': 'GitNexus: analysis complete. Knowledge graph ready.',
  'analyze.failed': 'GitNexus: analysis failed. Check the terminal for details.',
  'query.usage': 'Usage: /gitnexus query <text>',
  'context.usage': 'Usage: /gitnexus context <name>',
  'impact.usage': 'Usage: /gitnexus impact <name>',
  'result.none': 'No results.',
  'query.failed': 'GitNexus query failed.',
  'context.failed': 'GitNexus context lookup failed.',
  'impact.failed': 'GitNexus impact analysis failed.',
  'pattern.tooShort': 'Pattern too short (min 3 chars).',
  'pattern.noContext': 'No graph context found for: {pattern}',
  'autoAugment.state': 'GitNexus auto-augment {state}.',
} as const;

type Key = keyof typeof fallback;

const translations: Record<Locale, Partial<Record<Key, string>>> = {
  es: {
    'notify.active': 'GitNexus: grafo de conocimiento activo; las búsquedas se enriquecerán automáticamente.',
    'notify.missingBinary': 'Se encontró un índice GitNexus, pero gitnexus no está en PATH. Instala: npm i -g gitnexus',
    'status.notInstalled': 'gitnexus no está instalado. Instala: npm i -g gitnexus',
    'status.noIndex': 'No se encontró ningún índice GitNexus. Ejecuta: /gitnexus analyze',
    'analyze.start': 'GitNexus: analizando el código; esto puede tardar…',
    'analyze.complete': 'GitNexus: análisis completo. Grafo de conocimiento listo.',
    'analyze.failed': 'GitNexus: el análisis falló. Revisa la terminal para más detalles.',
    'query.usage': 'Uso: /gitnexus query <texto>',
    'context.usage': 'Uso: /gitnexus context <nombre>',
    'impact.usage': 'Uso: /gitnexus impact <nombre>',
    'result.none': 'Sin resultados.',
    'query.failed': 'La consulta de GitNexus falló.',
    'context.failed': 'La búsqueda de contexto de GitNexus falló.',
    'impact.failed': 'El análisis de impacto de GitNexus falló.',
    'pattern.tooShort': 'Patrón demasiado corto (mín. 3 caracteres).',
    'pattern.noContext': 'No se encontró contexto del grafo para: {pattern}',
    'autoAugment.state': 'Auto-augment de GitNexus {state}.',
  },
  fr: {
    'notify.active': 'GitNexus : graphe de connaissances actif — les recherches seront enrichies automatiquement.',
    'notify.missingBinary': 'Index GitNexus trouvé, mais gitnexus n’est pas dans le PATH. Installez : npm i -g gitnexus',
    'status.notInstalled': 'gitnexus n’est pas installé. Installez : npm i -g gitnexus',
    'status.noIndex': 'Aucun index GitNexus trouvé. Exécutez : /gitnexus analyze',
    'analyze.start': 'GitNexus : analyse du code en cours, cela peut prendre un moment…',
    'analyze.complete': 'GitNexus : analyse terminée. Graphe de connaissances prêt.',
    'analyze.failed': 'GitNexus : échec de l’analyse. Consultez le terminal pour plus de détails.',
    'query.usage': 'Utilisation : /gitnexus query <texte>',
    'context.usage': 'Utilisation : /gitnexus context <nom>',
    'impact.usage': 'Utilisation : /gitnexus impact <nom>',
    'result.none': 'Aucun résultat.',
    'query.failed': 'La requête GitNexus a échoué.',
    'context.failed': 'La recherche de contexte GitNexus a échoué.',
    'impact.failed': 'L’analyse d’impact GitNexus a échoué.',
    'pattern.tooShort': 'Motif trop court (3 caractères min.).',
    'pattern.noContext': 'Aucun contexte de graphe trouvé pour : {pattern}',
    'autoAugment.state': 'Auto-augmentation GitNexus {state}.',
  },
  'pt-BR': {
    'notify.active': 'GitNexus: grafo de conhecimento ativo — as buscas serão enriquecidas automaticamente.',
    'notify.missingBinary': 'Índice GitNexus encontrado, mas gitnexus não está no PATH. Instale: npm i -g gitnexus',
    'status.notInstalled': 'gitnexus não está instalado. Instale: npm i -g gitnexus',
    'status.noIndex': 'Nenhum índice GitNexus encontrado. Execute: /gitnexus analyze',
    'analyze.start': 'GitNexus: analisando o código; isso pode levar um tempo…',
    'analyze.complete': 'GitNexus: análise concluída. Grafo de conhecimento pronto.',
    'analyze.failed': 'GitNexus: a análise falhou. Verifique o terminal para detalhes.',
    'query.usage': 'Uso: /gitnexus query <texto>',
    'context.usage': 'Uso: /gitnexus context <nome>',
    'impact.usage': 'Uso: /gitnexus impact <nome>',
    'result.none': 'Sem resultados.',
    'query.failed': 'A consulta do GitNexus falhou.',
    'context.failed': 'A busca de contexto do GitNexus falhou.',
    'impact.failed': 'A análise de impacto do GitNexus falhou.',
    'pattern.tooShort': 'Padrão curto demais (mín. 3 caracteres).',
    'pattern.noContext': 'Nenhum contexto do grafo encontrado para: {pattern}',
    'autoAugment.state': 'Auto-augment do GitNexus {state}.',
  },
};

let currentLocale: string | undefined;

function format(template: string, params: Params = {}): string {
  return template.replace(/\{(\w+)\}/g, (_match, key) => String(params[key] ?? `{${key}}`));
}

export function t(key: Key, params?: Params): string {
  const locale = currentLocale as Locale | undefined;
  return format((locale ? translations[locale]?.[key] : undefined) ?? fallback[key], params);
}

export function initI18n(pi: ExtensionAPI): void {
  pi.events?.emit?.('pi-core/i18n/registerBundle', { namespace, defaultLocale: 'en', fallback, translations });
  pi.events?.on?.('pi-core/i18n/localeChanged', (event: unknown) => {
    currentLocale = event && typeof event === 'object' && 'locale' in event ? String((event as { locale?: unknown }).locale ?? '') : undefined;
  });
  pi.events?.emit?.('pi-core/i18n/requestApi', { namespace, onApi(api: { getLocale?: () => string | undefined }) { currentLocale = api.getLocale?.(); } });
}
