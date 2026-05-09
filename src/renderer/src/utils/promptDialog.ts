let promptResolveId = 0;

export function showPromptDialog(title: string, defaultValue?: string): Promise<string | null> {
  return new Promise((resolve) => {
    const resolveId = `prompt-${++promptResolveId}`;

    const handleResult = (e: CustomEvent<{ value: string | null; resolveId: string }>) => {
      if (e.detail.resolveId === resolveId) {
        window.removeEventListener('prompt-dialog-result', handleResult as EventListener);
        resolve(e.detail.value);
      }
    };

    window.addEventListener('prompt-dialog-result', handleResult as EventListener);
    window.dispatchEvent(new CustomEvent('show-prompt-dialog', {
      detail: { title, defaultValue, resolveId }
    }));
  });
}