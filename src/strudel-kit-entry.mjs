export * from '@strudel/web';
import { appendStrudelLayer, highlightStrudel } from './strudel-score.js';

window.EaselStrudelScore = Object.freeze({ appendLayer: appendStrudelLayer, highlight: highlightStrudel });
