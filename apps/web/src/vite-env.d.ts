/// <reference types="vite/client" />

// Build-time provenance injected by vite.config.ts. Used by the
// Dashboard footer + anywhere else we surface "what version is this".
declare const __MAGISTER_BUILD_SHA__: string;
declare const __MAGISTER_BUILD_AT__: string;
