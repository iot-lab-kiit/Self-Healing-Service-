'use strict';

const { createApp, log } = require('./app');

const PORT = parseInt(process.env.PORT, 10) || 5000;
const EXCLUSIVE_MACHINE = process.env.EXCLUSIVE_MACHINE || 'machine-1';
const GPU_UPSTREAM = process.env.GPU_UPSTREAM || `http://${EXCLUSIVE_MACHINE}:3000`;

const app = createApp({ exclusiveMachine: EXCLUSIVE_MACHINE, gpuUpstream: GPU_UPSTREAM });

app.listen(PORT, '0.0.0.0', () => {
  log('info', `smart-lb-controller listening on :${PORT}`, { exclusiveMachine: EXCLUSIVE_MACHINE, upstream: GPU_UPSTREAM });
});
