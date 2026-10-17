import React from 'react';
/** The few line icons the plugin needs, drawn on a 24-unit grid like the host's icon set; no icon package is bundled. */
const icon = (paths: React.ReactNode) => function Icon({ size = 16 }: { size?: number }) {
  return <svg className="dpm-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths}</svg>;
};
export const Gauge = /* @__PURE__ */ icon(<><path d="m12 14 4-4" /><path d="M3.34 19a10 10 0 1 1 17.32 0" /></>);
export const Info = /* @__PURE__ */ icon(<><circle cx="12" cy="12" r="9" /><path d="M12 16v-4" /><path d="M12 8h.01" /></>);
export const Alert = /* @__PURE__ */ icon(<><circle cx="12" cy="12" r="9" /><path d="M12 8v4" /><path d="M12 16h.01" /></>);
export const Chevron = /* @__PURE__ */ icon(<path d="m9 18 6-6-6-6" />);
export const ArrowDown = /* @__PURE__ */ icon(<><path d="M12 5v14" /><path d="m19 12-7 7-7-7" /></>);
export const Close = /* @__PURE__ */ icon(<><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>);
export const Refresh = /* @__PURE__ */ icon(<><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /></>);
export const Copy = /* @__PURE__ */ icon(<><rect width="13" height="13" x="9" y="9" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>);
