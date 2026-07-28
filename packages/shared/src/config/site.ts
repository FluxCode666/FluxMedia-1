export const siteConfig = {
  name: process.env.NEXT_PUBLIC_APP_NAME || "FluxMedia",

  description:
    "AI-powered chat-to-image generation platform. Transform your words into stunning visuals through natural conversation.",

  url: process.env.NEXT_PUBLIC_APP_URL || "https://media.flux-code.cc",

  logo: "/assets/logo.png",

  icon: "/assets/icon.png",

  ogImage: "/og-image.png",

  author: {
    name: "FluxMedia Team",
    url: "https://media.flux-code.cc",
    email: "support@media.flux-code.cc",
  },

  links: {
    twitter: "",
    github: "",
    discord: "",
  },

  keywords: [
    "AI Image Generation",
    "Chat to Image",
    "Text to Image",
    "AI Art",
    "FluxMedia",
    "Image Generation API",
    "Creative AI",
  ],
} as const;

export type SiteConfig = typeof siteConfig;
