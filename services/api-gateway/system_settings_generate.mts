/** Regenerate the Go backend's deployment-independent settings contract. */
import { writeFileSync } from 'node:fs';
import { SYSTEM_SETTING_DEFINITIONS } from '../../packages/shared/src/system-settings/definitions.ts';
writeFileSync(new URL('./system_settings_definitions.json', import.meta.url), `${JSON.stringify(SYSTEM_SETTING_DEFINITIONS, null, 2)}\n`);
