import { reportClientCore } from './report-client-core.js';
import { reportClientViews } from './report-client-views.js';
import { reportClientActions } from './report-client-actions.js';

/** 单片内联脚本；片段顺序固定，共享同一个 IIFE 词法作用域。slice(1) 去掉片段自带的起始换行。 */
export const reportClientScript = reportClientCore + reportClientViews.slice(1) + reportClientActions.slice(1);
