import type { ReactNode } from "react";

export function WorkspaceModal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-slate-950/50 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section role="dialog" aria-modal="true" className="my-auto w-full max-w-2xl rounded-3xl bg-white p-5 shadow-2xl sm:p-7"><div className="mb-5 flex items-start justify-between gap-4"><div><p className="text-[10px] font-bold uppercase tracking-[.18em] text-orange-700">Volta Finance</p><h2 className="mt-1 text-2xl font-bold tracking-tight">{title}</h2></div><button onClick={onClose} aria-label="Close" className="grid h-9 w-9 place-items-center rounded-full text-xl text-slate-500 hover:bg-slate-100">×</button></div>{children}</section></div>;
}
