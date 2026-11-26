const js = require('@eslint/js');
const globals = require('globals');

// The browser files are plain scripts that share one scope, in the order views/shell.html loads them.
const shared = { $: 'readonly', $$: 'readonly', escapeHtml: 'readonly', icon: 'readonly', setPressed: 'readonly', skeletons: 'readonly', emptyState: 'readonly', toast: 'readonly', api: 'readonly', post: 'readonly', withBusy: 'readonly', copyText: 'readonly', fullNumber: 'readonly', shortAmount: 'readonly', parseAmount: 'readonly', winnerPayout: 'readonly', clock: 'readonly', timeAgo: 'readonly', isCrystal: 'readonly', modeName: 'readonly', itemIcon: 'readonly', modeItem: 'readonly', snipeIcon: 'readonly', matchRegion: 'readonly', matchHref: 'readonly', matchTerms: 'readonly', statusTag: 'readonly', avatar: 'readonly', playerTags: 'readonly', sendWithTax: 'readonly', receiveAfterTax: 'readonly', tierBadge: 'readonly', siteTierBadges: 'readonly', tiersPanel: 'readonly', tierSummary: 'readonly', tierDate: 'readonly', TIER_STATES: 'readonly', confirmDialog: 'readonly', me: 'writable', registerPage: 'readonly', navigate: 'readonly', markActive: 'readonly', mountPage: 'readonly', playEnter: 'readonly', closeMenus: 'readonly', prefs: 'readonly', applyBackground: 'readonly', selectGame: 'readonly', selectedGame: 'readonly', gameListeners: 'readonly', refreshViewer: 'readonly', renderViewer: 'readonly', refreshAccount: 'readonly', handleAuthError: 'readonly', loadNotifications: 'readonly', loadRecent: 'readonly', statsCards: 'readonly', featuredCard: 'readonly', openStatistics: 'readonly', memberSince: 'readonly', openVerify: 'readonly', ensureAllowed: 'readonly', live: 'readonly', coalesce: 'readonly', createSupportView: 'readonly', historyCard: 'readonly', historyPager: 'readonly', skinHeadImage: 'readonly' };

module.exports = [
  { ignores: ['node_modules/', 'test-results/', 'playwright-report/'] },
  js.configs.recommended,
  { files: ['**/*.js'], languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: globals.node }, rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }], 'no-control-regex': 'off', eqeqeq: 'error', 'prefer-const': 'error', 'no-var': 'error' } },
  { files: ['public/**/*.js'], languageOptions: { sourceType: 'script', globals: { ...globals.browser, ...shared } }, rules: { 'no-redeclare': 'off', 'no-unused-vars': ['error', { vars: 'local', argsIgnorePattern: '^_', caughtErrors: 'none' }] } },
  { files: ['public/common.js', 'public/shell.js'], rules: { 'no-unused-vars': ['error', { vars: 'local', caughtErrors: 'none' }] } },
  { files: ['e2e/**/*.js'], languageOptions: { globals: { ...globals.node, ...globals.browser, refreshAccount: 'readonly' } }, rules: { 'no-empty-pattern': 'off' } },
];
