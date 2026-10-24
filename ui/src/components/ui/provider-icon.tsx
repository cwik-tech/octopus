import { Bot, Boxes, Cable, CircleGauge, Router } from "lucide-react";

import alibabaLogo from "@lobehub/icons-static-svg/icons/alibaba-color.svg";
import anthropicLogo from "@lobehub/icons-static-svg/icons/anthropic.svg";
import awsLogo from "@lobehub/icons-static-svg/icons/aws-color.svg";
import claudeCodeLogo from "@lobehub/icons-static-svg/icons/claudecode-color.svg";
import cohereLogo from "@lobehub/icons-static-svg/icons/cohere-color.svg";
import deepSeekLogo from "@lobehub/icons-static-svg/icons/deepseek-color.svg";
import geminiCliLogo from "@lobehub/icons-static-svg/icons/geminicli-color.svg";
import geminiLogo from "@lobehub/icons-static-svg/icons/gemini-color.svg";
import googleLogo from "@lobehub/icons-static-svg/icons/google-color.svg";
import lmStudioLogo from "@lobehub/icons-static-svg/icons/lmstudio.svg";
import metaLogo from "@lobehub/icons-static-svg/icons/meta-color.svg";
import microsoftLogo from "@lobehub/icons-static-svg/icons/microsoft-color.svg";
import minimaxLogo from "@lobehub/icons-static-svg/icons/minimax-color.svg";
import mistralLogo from "@lobehub/icons-static-svg/icons/mistral-color.svg";
import moonshotLogo from "@lobehub/icons-static-svg/icons/moonshot.svg";
import nvidiaLogo from "@lobehub/icons-static-svg/icons/nvidia-color.svg";
import ollamaLogo from "@lobehub/icons-static-svg/icons/ollama.svg";
import openAiLogo from "@lobehub/icons-static-svg/icons/openai.svg";
import openRouterLogo from "@lobehub/icons-static-svg/icons/openrouter.svg";
import qwenLogo from "@lobehub/icons-static-svg/icons/qwen-color.svg";
import xAiLogo from "@lobehub/icons-static-svg/icons/xai.svg";
import zhipuLogo from "@lobehub/icons-static-svg/icons/zhipu-color.svg";

import piLogo from "@/assets/pi.svg";
import { cn } from "@/lib/utils/utils";

interface ProviderLogo {
  id: string;
  src: string;
  monochrome?: boolean;
}

const LOGOS: Record<string, ProviderLogo> = {
  // Codex CLI runs OpenAI models; brand it with the OpenAI mark everywhere.
  codex: { id: "openai", src: openAiLogo, monochrome: true },
  claude: { id: "claudecode", src: claudeCodeLogo },
  anthropic: { id: "anthropic", src: anthropicLogo, monochrome: true },
  openai: { id: "openai", src: openAiLogo, monochrome: true },
  gemini: { id: "geminicli", src: geminiCliLogo },
  google: { id: "google", src: googleLogo },
  "google-vertex": { id: "google", src: googleLogo },
  "google-vertex-anthropic": { id: "anthropic", src: anthropicLogo, monochrome: true },
  deepseek: { id: "deepseek", src: deepSeekLogo },
  "x-ai": { id: "xai", src: xAiLogo, monochrome: true },
  xai: { id: "xai", src: xAiLogo, monochrome: true },
  moonshotai: { id: "moonshot", src: moonshotLogo, monochrome: true },
  moonshot: { id: "moonshot", src: moonshotLogo, monochrome: true },
  "kimi-cli": { id: "moonshot", src: moonshotLogo, monochrome: true },
  qwen: { id: "qwen", src: qwenLogo },
  pi: { id: "pi", src: piLogo },
  alibaba: { id: "alibaba", src: alibabaLogo },
  alibabacloud: { id: "alibaba", src: alibabaLogo },
  mistralai: { id: "mistral", src: mistralLogo },
  mistral: { id: "mistral", src: mistralLogo },
  "meta-llama": { id: "meta", src: metaLogo },
  meta: { id: "meta", src: metaLogo },
  cohere: { id: "cohere", src: cohereLogo },
  minimax: { id: "minimax", src: minimaxLogo },
  "z-ai": { id: "zhipu", src: zhipuLogo },
  zai: { id: "zhipu", src: zhipuLogo },
  zhipuai: { id: "zhipu", src: zhipuLogo },
  microsoft: { id: "microsoft", src: microsoftLogo },
  amazon: { id: "aws", src: awsLogo },
  "amazon-bedrock": { id: "aws", src: awsLogo },
  aws: { id: "aws", src: awsLogo },
  nvidia: { id: "nvidia", src: nvidiaLogo },
  openrouter: { id: "openrouter", src: openRouterLogo, monochrome: true },
  ollama: { id: "ollama", src: ollamaLogo, monochrome: true },
  lmstudio: { id: "lmstudio", src: lmStudioLogo, monochrome: true },
  "lm-studio": { id: "lmstudio", src: lmStudioLogo, monochrome: true },
  // OpenRouter may identify Google's Gemini family directly.
  "google-gemini": { id: "gemini", src: geminiLogo },
};

export function ProviderIcon({
  provider,
  className,
}: {
  provider: string;
  className?: string;
}) {
  const slug = provider.toLowerCase();
  const logo = LOGOS[slug];
  if (logo) {
    return (
      <span
        aria-hidden="true"
        data-provider-logo={logo.id}
        className={cn(
          "inline-flex size-5 shrink-0 items-center justify-center",
          className,
        )}
      >
        <img
          alt=""
          src={logo.src}
          className={cn(
            "size-full object-contain",
            logo.monochrome && "dark:invert",
          )}
        />
      </span>
    );
  }

  const Icon =
    slug === "api" || slug === "openai-compatible"
      ? Cable
      : slug === "local"
        ? CircleGauge
        : slug === "router"
          ? Router
          : slug === "models"
            ? Boxes
            : Bot;
  return (
    <span
      aria-hidden="true"
      data-provider-logo="fallback"
      className={cn(
        "inline-flex size-5 shrink-0 items-center justify-center text-muted-foreground",
        className,
      )}
    >
      <Icon className="size-[70%]" />
    </span>
  );
}
