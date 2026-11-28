import type { ReportStepApi } from '../shared/report-model.js';
import { projectReportValue } from '../shared/acceptance.js';

type Ev = Record<string, unknown>;

export function buildReportApis(requests: Ev[], ids: string[], readBody: (ref: unknown) => string | undefined): ReportStepApi[] {
  return ids.flatMap(id => {
    const request = requests.find(event => event.id === id);
    if (!request || !['xhr', 'fetch'].includes(String(request.resource_type).toLowerCase())) return [];
    const url = String(request.url ?? '');
    const contentType = String(Object.entries((request.resp_headers ?? {}) as Ev).find(([key]) => key.toLowerCase() === 'content-type')?.[1] ?? '');
    let pathname = '';
    try { pathname = new URL(url).pathname; } catch {}
    if (/(?:cookie|token|password|passwd|pwd|secret|credential|authorization)/i.test(pathname)) return [];
    if (/html|javascript|css|image\/|font\//i.test(contentType) || /\.(?:html?|js|css|png|jpe?g|svg|woff2?)(?:\?|$)/i.test(url)) return [];
    const headers = typeof request.resp_headers === 'string' ? request.resp_headers
      : Object.entries((request.resp_headers ?? {}) as Ev).map(([key, value]) => `${key}: ${value}`).join('\n');
    const api: ReportStepApi = {
      reqId: id, method: String(request.method ?? ''), url, status: String(request.status ?? ''),
      path: String(request.path ?? ''), nav: String(request.nav ?? ''), callIndex: Number(request.call_index),
      reqBodyRef: typeof request.req_body_ref === 'string' ? request.req_body_ref : undefined,
      respBodyRef: typeof request.resp_body_ref === 'string' ? request.resp_body_ref : undefined,
      reqBody: readBody(request.req_body_ref), respBody: readBody(request.resp_body_ref), respHeaders: headers,
      traceId: headers.match(/^\s*eagleeye-traceid\s*:\s*(\S+)/im)?.[1],
      time: typeof request.started === 'number' ? new Date(request.started).toISOString() : undefined,
    };
    return [projectReportValue(api).value as ReportStepApi];
  });
}
