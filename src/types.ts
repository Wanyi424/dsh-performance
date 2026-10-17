import type React from 'react';
export interface ClientContext {
  effect(fn: () => (() => unknown), label?: string): unknown;
  locale: { register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void };
  layout: {
    selectPanel(id: string | null): void;
    /** The host's shared central-panel selection; the sidebar rows read the same source. */
    panelInfo: { getSnapshot(): { activePanelId: string | null }; subscribe(listener: () => void): () => void };
  };
  slots: { inject(slot: string, fn: () => unknown): unknown; register(options: { name: string; key?: string; id?: string; order?: number; locale?: string }, component: React.ComponentType<any>): () => void };
}
