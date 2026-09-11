/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_OPENROUTER_API_KEY?: string;
  readonly VITE_OPENROUTER_MODEL?: string;
  readonly VITE_OPENROUTER_FREE_MODEL?: string;
  readonly VITE_OPENROUTER_VISION_MODEL?: string;
  readonly VITE_OPENROUTER_FREE_TIER?: string;
  readonly VITE_GITHUB_MODELS_TOKEN?: string;
  readonly VITE_GOOGLE_AI_STUDIO_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}