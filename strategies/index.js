import browserEsmStrategy from './browser-esm.js';
import configuredStrategy from './configured.js';
import esbuildStrategy from './esbuild.js';

// 按顺序匹配，命中即停；esbuild 为默认 fallback
export const STRATEGIES = [configuredStrategy, browserEsmStrategy, esbuildStrategy];
