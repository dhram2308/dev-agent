// ═══════════════════════════════════════════════════════════════
// MI Dev Agent -- OAuth Provider Registration Barrel
//
// Importing this module triggers self-registration of all
// provider adapters via registerProvider(). This must be
// imported once during application bootstrap (typically from
// the OAuth route handler or the main server entry point).
// ═══════════════════════════════════════════════════════════════

import './google';
import './figma';
import './gitlab';
