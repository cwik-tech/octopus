import { useCallback, useState } from "react";

export function useSettingsController() {
  const [isOpen, setIsOpen] = useState(false);
  const [sectionRequest, setSectionRequest] = useState<{
    section: "scheduling-queue";
    requestId: string;
  } | null>(null);

  const openSettings = useCallback(() => {
    setSectionRequest(null);
    setIsOpen(true);
  }, []);

  const openSchedulingSettings = useCallback(() => {
    setSectionRequest({
      section: "scheduling-queue",
      requestId: crypto.randomUUID(),
    });
    setIsOpen(true);
  }, []);

  return {
    isOpen,
    openSchedulingSettings,
    openSettings,
    sectionRequest,
    setIsOpen,
  };
}

export type SettingsController = ReturnType<typeof useSettingsController>;
