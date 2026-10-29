// -----------------------------------------------------------------------------
// Entry point: SDK wiring only. Every handler is registered BEFORE connect(),
// and delegates to the DropletApp (src/app.js). Read-only: no command
// handler, the Droplet is never commanded.
//
// Environment variables provided by the Gladys supervisor, read by the SDK:
// GLADYS_HOST_API_URL, GLADYS_INTEGRATION_TOKEN, GLADYS_INTEGRATION_SELECTOR.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { DropletApp } from './src/app.js';
import { ACTIONS } from './src/constants.js';

const gladys = new GladysIntegration();
const app = new DropletApp({ gladys });

// --- Discovery -------------------------------------------------------------------
// The Droplets met at the address, never a connection.
gladys.onScanRequest(() => app.scan());
// A device created or updated: its values are sent again (the live ones only while fresh).
gladys.onDeviceCreated((device) => app.onDeviceCreated(device));
gladys.onDeviceUpdated((device) => app.onDeviceUpdated(device));
gladys.onDeviceDeleted((device) => app.onDeviceDeleted(device));

// --- Configuration screen buttons -----------------------------------------------
gladys.onAction(ACTIONS.TEST, () => app.testConnection());
// The only way to count a volume held back (a save of the form never does).
gladys.onAction(ACTIONS.ACCEPT_HELD, () => app.acceptHeld());

// --- Configuration changed by the user ----------------------------------------
gladys.onConfigUpdated((config) => {
  logger.info('Configuration updated');
  return app.configUpdated(config);
});

// --- Connection lifecycle ------------------------------------------------------
// Every connection (the first one and each reconnection) reads the
// configuration (tried again without end while Gladys cannot give it), then
// publishes the Discovery list and the status again. The Droplet stays
// connected while Gladys is away: its volumes keep counting.
gladys.on('connected', () => {
  app
    .connected(() => gladys.getConfig())
    .catch((err) => {
      logger.error(`Start failed (${err?.name ?? 'Error'})`);
    });
});
gladys.on('disconnected', () => {
  app.disconnected().catch((err) => logger.error(`Disconnect failed (${err?.name ?? 'Error'})`));
});
gladys.handleShutdown(() => app.stop());

logger.info('Starting the Droplet integration...');
gladys.connect().catch((err) => {
  logger.error(`Initial connection failed (${err?.name ?? 'Error'})`);
  process.exit(1);
});
