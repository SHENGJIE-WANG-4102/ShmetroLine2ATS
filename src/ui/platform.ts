/** Keep desktop detection in one place for startup and native exports. */
export const isDesktop = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
