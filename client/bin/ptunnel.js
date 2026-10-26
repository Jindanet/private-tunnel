#!/usr/bin/env node
'use strict';

require('../cli').main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = error.name === 'AbortError' ? 130 : 1;
});
