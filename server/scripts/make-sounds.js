'use strict';
// Creates the placeholder sound library if it doesn't exist yet.
const ids = require('../lib/placeholderSounds').createPlaceholderSounds();
console.log(`[sounds] ${ids.length} placeholder sounds ready`);
