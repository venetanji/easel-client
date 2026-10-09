export * from '@strudel/web';
import * as native from '@strudel/web';
import { appendStrudelLayer, highlightStrudel } from './strudel-score.js';
import { createStrudelSamples } from './strudel-samples.js';
import drumBank from '../assets/strudel-drums/bank.json';

window.EaselStrudelScore = Object.freeze({ appendLayer: appendStrudelLayer, highlight: highlightStrudel });
window.EaselStrudelSamples = createStrudelSamples(native, drumBank, () => window.EaselCanvas?.assets);
