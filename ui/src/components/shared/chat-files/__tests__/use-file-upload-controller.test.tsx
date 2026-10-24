import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FileUploadApi } from "@/components/shared/file-upload";
import type { SessionFile } from "@/lib/models/session-model";

import { useFileUploadController } from "../use-file-upload-controller";

const makeSessionFile = (
  name: string,
  overrides: Partial<SessionFile> = {},
): SessionFile => ({
  name,
  size: 100,
  uploadedAt: "2026-08-03T10:00:00.000Z",
  parseStatus: "parsed",
  ...overrides,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const createApi = () => ({
  list: vi.fn<FileUploadApi["list"]>(async () => []),
  upload: vi.fn<FileUploadApi["upload"]>(),
  delete: vi.fn<FileUploadApi["delete"]>(async () => undefined),
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useFileUploadController", () => {
  it("is inactive without an owner", async () => {
    const api = createApi();
    const { result } = renderHook(() =>
      useFileUploadController({ ownerId: null, api }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(api.list).not.toHaveBeenCalled();
    expect(result.current.items).toEqual([]);
    expect(result.current.currentFiles).toEqual([]);
  });

  it("lists current files when an owner is set", async () => {
    const api = createApi();
    const fileA = makeSessionFile("a.txt");
    api.list.mockResolvedValue([fileA]);

    const { result } = renderHook(() =>
      useFileUploadController({ ownerId: "s1", api }),
    );

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(api.list).toHaveBeenCalledWith("s1");
    expect(result.current.currentFiles).toEqual([fileA]);
    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0]).toMatchObject({
      state: "current",
      filename: "a.txt",
      ownerId: "s1",
    });
    expect(result.current.items[0]?.key).toBe(
      `file:s1:a.txt:${fileA.uploadedAt}`,
    );
  });

  it("adds an optimistic item during upload, then reconciles with the list", async () => {
    const api = createApi();
    const { result } = renderHook(() =>
      useFileUploadController({ ownerId: "s1", api }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    const pendingUpload = deferred<SessionFile>();
    api.upload.mockReturnValue(pendingUpload.promise);
    const file = new File(["hello"], "note.txt", { type: "text/plain" });

    let uploadPromise: Promise<void> | undefined;
    act(() => {
      uploadPromise = result.current.upload([file]);
    });

    expect(api.upload).toHaveBeenCalledWith("s1", file);
    expect(result.current.uploading).toBe(true);
    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0]).toMatchObject({
      state: "uploading",
      filename: "note.txt",
    });
    expect(result.current.items[0]?.key.startsWith("attempt:s1:")).toBe(true);

    const uploaded = makeSessionFile("note.txt");
    api.list.mockResolvedValue([uploaded]);
    await act(async () => {
      pendingUpload.resolve(uploaded);
      await uploadPromise;
    });

    expect(result.current.uploading).toBe(false);
    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0]).toMatchObject({
      state: "current",
      filename: "note.txt",
    });
    expect(result.current.items[0]?.file).toEqual(uploaded);
    expect(result.current.items[0]?.retryFile).toBeUndefined();
  });

  it("refreshes the list after a failure and shows an error item with retry", async () => {
    const api = createApi();
    const { result } = renderHook(() =>
      useFileUploadController({ ownerId: "s1", api }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    const pendingUpload = deferred<SessionFile>();
    api.upload.mockReturnValue(pendingUpload.promise);
    const file = new File(["x"], "bad.txt");

    let uploadPromise: Promise<void> | undefined;
    act(() => {
      uploadPromise = result.current.upload([file]);
    });
    await act(async () => {
      pendingUpload.reject(new Error("boom"));
      await uploadPromise;
    });

    // Initial list plus the post-failure refresh.
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(result.current.uploading).toBe(false);
    expect(result.current.currentFiles).toEqual([]);
    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0]).toMatchObject({
      state: "error",
      filename: "bad.txt",
      error: "boom",
    });
    expect(result.current.items[0]?.retryFile).toBe(file);
  });

  it("reconciles instead of erroring when a new revision appears after a failed upload", async () => {
    const api = createApi();
    const { result } = renderHook(() =>
      useFileUploadController({ ownerId: "s1", api }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    const uploaded = makeSessionFile("dup.txt");
    api.list.mockResolvedValue([uploaded]);
    const pendingUpload = deferred<SessionFile>();
    api.upload.mockReturnValue(pendingUpload.promise);
    const file = new File(["x"], "dup.txt");

    let uploadPromise: Promise<void> | undefined;
    act(() => {
      uploadPromise = result.current.upload([file]);
    });
    await act(async () => {
      pendingUpload.reject(new Error("conflict"));
      await uploadPromise;
    });

    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0]).toMatchObject({
      state: "current",
      filename: "dup.txt",
    });
  });

  it("continues a multi-file batch after an individual failure", async () => {
    const api = createApi();
    const uploadedSecond = makeSessionFile("second.txt");
    api.list
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([uploadedSecond]);
    api.upload
      .mockRejectedValueOnce(new Error("nope"))
      .mockResolvedValueOnce(uploadedSecond);
    const { result } = renderHook(() =>
      useFileUploadController({ ownerId: "s1", api }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    const first = new File(["1"], "first.txt");
    const second = new File(["2"], "second.txt");

    await act(async () => {
      await result.current.upload([first, second]);
    });

    expect(api.upload).toHaveBeenCalledTimes(2);
    expect(api.upload).toHaveBeenCalledWith("s1", first);
    expect(api.upload).toHaveBeenCalledWith("s1", second);
    expect(result.current.items).toHaveLength(2);
    expect(result.current.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: "error", filename: "first.txt" }),
        expect.objectContaining({ state: "current", filename: "second.txt" }),
      ]),
    );
  });

  it("refreshes once after an entirely successful multi-file batch", async () => {
    const api = createApi();
    const firstUploaded = makeSessionFile("first.txt");
    const secondUploaded = makeSessionFile("second.txt", {
      uploadedAt: "2026-08-03T10:00:01.000Z",
    });
    api.list
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([firstUploaded, secondUploaded]);
    api.upload
      .mockResolvedValueOnce(firstUploaded)
      .mockResolvedValueOnce(secondUploaded);
    const { result } = renderHook(() =>
      useFileUploadController({ ownerId: "s1", api }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.upload([
        new File(["1"], "first.txt"),
        new File(["2"], "second.txt"),
      ]);
    });

    expect(api.list).toHaveBeenCalledTimes(2);
    expect(result.current.currentFiles).toEqual([
      firstUploaded,
      secondUploaded,
    ]);
  });

  it("queues an additional multi-file selection while an upload is active", async () => {
    const api = createApi();
    const { result } = renderHook(() =>
      useFileUploadController({ ownerId: "s1", api }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    const firstPending = deferred<SessionFile>();
    const secondPending = deferred<SessionFile>();
    api.upload
      .mockReturnValueOnce(firstPending.promise)
      .mockReturnValueOnce(secondPending.promise);
    const first = new File(["1"], "first.txt");
    const second = new File(["2"], "second.txt");

    let firstBatch!: Promise<void>;
    let secondBatch!: Promise<void>;
    act(() => {
      firstBatch = result.current.upload([first]);
      secondBatch = result.current.upload([second]);
    });

    expect(api.upload).toHaveBeenCalledTimes(1);
    expect(result.current.items).toHaveLength(2);
    expect(result.current.items.every((item) => item.state === "uploading")).toBe(
      true,
    );

    const uploadedFirst = makeSessionFile("first.txt");
    api.list.mockResolvedValue([uploadedFirst]);
    await act(async () => {
      firstPending.resolve(uploadedFirst);
      await firstBatch;
    });
    expect(api.upload).toHaveBeenCalledTimes(2);
    expect(api.upload).toHaveBeenLastCalledWith("s1", second);

    const uploadedSecond = makeSessionFile("second.txt", {
      uploadedAt: "2026-08-03T10:00:01.000Z",
    });
    api.list.mockResolvedValue([uploadedFirst, uploadedSecond]);
    await act(async () => {
      secondPending.resolve(uploadedSecond);
      await secondBatch;
    });
    expect(result.current.items.map((item) => item.filename)).toEqual([
      "first.txt",
      "second.txt",
    ]);
    expect(result.current.uploading).toBe(false);
  });

  it("keeps the newest same-owner refresh result", async () => {
    const api = createApi();
    const { result } = renderHook(() =>
      useFileUploadController({ ownerId: "s1", api }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    const older = deferred<SessionFile[]>();
    const newer = deferred<SessionFile[]>();
    api.list.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    let olderRefresh!: Promise<void>;
    let newerRefresh!: Promise<void>;
    act(() => {
      olderRefresh = result.current.refresh();
      newerRefresh = result.current.refresh();
    });

    const newestFile = makeSessionFile("new.txt");
    await act(async () => {
      newer.resolve([newestFile]);
      await newerRefresh;
    });
    await act(async () => {
      older.resolve([makeSessionFile("old.txt")]);
      await olderRefresh;
    });

    expect(result.current.currentFiles).toEqual([newestFile]);
  });

  it("preserves an unchanged authoritative item identity across refreshes", async () => {
    const api = createApi();
    const fileA = makeSessionFile("a.txt");
    api.list.mockResolvedValue([fileA]);
    const { result } = renderHook(() =>
      useFileUploadController({ ownerId: "s1", api }),
    );
    await waitFor(() => expect(result.current.currentFiles).toHaveLength(1));
    const initialItem = result.current.items[0];

    api.list.mockResolvedValue([{ ...fileA }]);
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.items[0]).toBe(initialItem);
  });

  it("preserves a same-name conflict after the first file in a batch succeeds", async () => {
    const api = createApi();
    const firstRevision = makeSessionFile("same.txt");
    api.list
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([firstRevision])
      .mockResolvedValueOnce([firstRevision]);
    api.upload
      .mockResolvedValueOnce(firstRevision)
      .mockRejectedValueOnce(new Error("name conflict"));
    const { result } = renderHook(() =>
      useFileUploadController({ ownerId: "s1", api }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.upload([
        new File(["1"], "same.txt"),
        new File(["2"], "same.txt"),
      ]);
    });

    expect(result.current.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: "current", filename: "same.txt" }),
        expect.objectContaining({
          state: "error",
          filename: "same.txt",
          error: "name conflict",
        }),
      ]),
    );
  });

  it("retry reuses the same original File object", async () => {
    const api = createApi();
    const { result } = renderHook(() =>
      useFileUploadController({ ownerId: "s1", api }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    const pendingUpload = deferred<SessionFile>();
    api.upload.mockReturnValue(pendingUpload.promise);
    const file = new File(["x"], "retry.txt");

    let uploadPromise: Promise<void> | undefined;
    act(() => {
      uploadPromise = result.current.upload([file]);
    });
    await act(async () => {
      pendingUpload.reject(new Error("boom"));
      await uploadPromise;
    });
    const errorKey = result.current.items[0]?.key;
    expect(errorKey).toBeDefined();

    api.upload.mockClear();
    const retryUpload = deferred<SessionFile>();
    api.upload.mockReturnValue(retryUpload.promise);
    let retryPromise: Promise<void> | undefined;
    act(() => {
      retryPromise = result.current.retry(errorKey as string);
    });

    expect(api.upload).toHaveBeenCalledTimes(1);
    expect(api.upload.mock.calls[0]?.[1]).toBe(file);

    const uploaded = makeSessionFile("retry.txt");
    api.list.mockResolvedValue([uploaded]);
    await act(async () => {
      retryUpload.resolve(uploaded);
      await retryPromise;
    });
    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0]?.state).toBe("current");
  });

  it("dismiss removes an error item", async () => {
    const api = createApi();
    const { result } = renderHook(() =>
      useFileUploadController({ ownerId: "s1", api }),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    const pendingUpload = deferred<SessionFile>();
    api.upload.mockReturnValue(pendingUpload.promise);
    const file = new File(["x"], "bad.txt");

    let uploadPromise: Promise<void> | undefined;
    act(() => {
      uploadPromise = result.current.upload([file]);
    });
    await act(async () => {
      pendingUpload.reject(new Error("boom"));
      await uploadPromise;
    });
    const errorKey = result.current.items[0]?.key as string;

    act(() => {
      result.current.dismiss(errorKey);
    });
    expect(result.current.items).toEqual([]);
  });

  it("deletes through the API and removes the item only after success", async () => {
    const api = createApi();
    const fileA = makeSessionFile("a.txt");
    api.list.mockResolvedValue([fileA]);
    const { result } = renderHook(() =>
      useFileUploadController({ ownerId: "s1", api }),
    );
    await waitFor(() => expect(result.current.currentFiles).toHaveLength(1));

    const pendingDelete = deferred<void>();
    api.delete.mockReturnValue(pendingDelete.promise);
    let removePromise: Promise<boolean> | undefined;
    act(() => {
      removePromise = result.current.remove("a.txt");
    });

    expect(api.delete).toHaveBeenCalledWith("s1", "a.txt");
    // Still visible until the server confirms.
    expect(result.current.items).toHaveLength(1);

    api.list.mockResolvedValue([]);
    await act(async () => {
      pendingDelete.resolve();
      await expect(removePromise).resolves.toBe(true);
    });
    expect(result.current.items).toEqual([]);
    expect(result.current.currentFiles).toEqual([]);
  });

  it("reports delete failure without removing the item", async () => {
    const api = createApi();
    const fileA = makeSessionFile("a.txt");
    api.list.mockResolvedValue([fileA]);
    api.delete.mockRejectedValue(new Error("delete failed"));
    const { result } = renderHook(() =>
      useFileUploadController({ ownerId: "s1", api }),
    );
    await waitFor(() => expect(result.current.currentFiles).toHaveLength(1));

    await act(async () => {
      await expect(result.current.remove("a.txt")).resolves.toBe(false);
    });

    expect(result.current.items).toHaveLength(1);
    expect(result.current.error).toBe("delete failed");
    expect(api.list).toHaveBeenCalledTimes(1);
  });

  it("waits for an active deletion before preparing provider submission", async () => {
    const api = createApi();
    const fileA = makeSessionFile("a.txt");
    api.list.mockResolvedValue([fileA]);
    const { result } = renderHook(() =>
      useFileUploadController({ ownerId: "s1", api }),
    );
    await waitFor(() => expect(result.current.currentFiles).toHaveLength(1));

    const pendingDelete = deferred<void>();
    api.delete.mockReturnValue(pendingDelete.promise);
    let deletePromise!: Promise<boolean>;
    let preparePromise!: Promise<boolean>;
    act(() => {
      deletePromise = result.current.remove("a.txt");
      preparePromise = result.current.prepareForSubmit();
    });
    let prepared = false;
    void preparePromise.then(() => {
      prepared = true;
    });
    await Promise.resolve();
    expect(prepared).toBe(false);

    api.list.mockResolvedValue([]);
    await act(async () => {
      pendingDelete.resolve();
      await expect(deletePromise).resolves.toBe(true);
      await expect(preparePromise).resolves.toBe(true);
    });
    expect(result.current.currentFiles).toEqual([]);
  });

  it("aborts provider submission when an active deletion fails", async () => {
    const api = createApi();
    const fileA = makeSessionFile("a.txt");
    api.list.mockResolvedValue([fileA]);
    const { result } = renderHook(() =>
      useFileUploadController({ ownerId: "s1", api }),
    );
    await waitFor(() => expect(result.current.currentFiles).toHaveLength(1));

    const pendingDelete = deferred<void>();
    api.delete.mockReturnValue(pendingDelete.promise);
    let preparePromise!: Promise<boolean>;
    act(() => {
      void result.current.remove("a.txt");
      preparePromise = result.current.prepareForSubmit();
    });

    await act(async () => {
      pendingDelete.reject(new Error("delete failed"));
      await expect(preparePromise).resolves.toBe(false);
    });
    expect(result.current.currentFiles).toEqual([fileA]);
    expect(result.current.error).toBe("delete failed");
  });

  it("optimistically freezes current files when preparing submission", async () => {
    const api = createApi();
    const fileA = makeSessionFile("a.txt");
    api.list.mockResolvedValue([fileA]);
    const { result } = renderHook(() =>
      useFileUploadController({ ownerId: "s1", api }),
    );
    await waitFor(() => expect(result.current.currentFiles).toHaveLength(1));

    await act(async () => {
      await expect(result.current.prepareForSubmit()).resolves.toBe(true);
    });

    expect(result.current.currentFiles[0]?.usedAt).toEqual(expect.any(String));
    expect(result.current.items[0]?.file?.usedAt).toEqual(expect.any(String));
  });

  it("clears optimistic state on owner change and ignores late completions", async () => {
    const api = createApi();
    const fileB = makeSessionFile("b.txt");
    api.list.mockImplementation(async (owner: string) =>
      owner === "s2" ? [fileB] : [],
    );
    const { result, rerender } = renderHook(
      ({ owner }: { owner: string }) =>
        useFileUploadController({ ownerId: owner, api }),
      { initialProps: { owner: "s1" } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    const pendingUpload = deferred<SessionFile>();
    api.upload.mockReturnValue(pendingUpload.promise);
    const file = new File(["x"], "late.txt");
    act(() => {
      void result.current.upload([file]);
    });
    expect(
      result.current.items.some((item) => item.state === "uploading"),
    ).toBe(true);

    rerender({ owner: "s2" });
    expect(
      result.current.items.some((item) => item.state === "uploading"),
    ).toBe(false);
    await waitFor(() =>
      expect(result.current.currentFiles.map((f) => f.name)).toEqual(["b.txt"]),
    );

    // The old-generation upload resolves after the switch: state must not change.
    await act(async () => {
      pendingUpload.resolve(makeSessionFile("late.txt"));
    });
    expect(result.current.items.map((item) => item.filename)).toEqual([
      "b.txt",
    ]);
    // The only s1 list call is the initial one; no stale refresh happened.
    expect(
      api.list.mock.calls.filter(([owner]) => owner === "s1"),
    ).toHaveLength(1);
  });

  it("does not let an old owner completion unlock the current owner queue", async () => {
    const api = createApi();
    const { result, rerender } = renderHook(
      ({ owner }: { owner: string }) =>
        useFileUploadController({ ownerId: owner, api }),
      { initialProps: { owner: "s1" } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));

    const oldPending = deferred<SessionFile>();
    const currentPending = deferred<SessionFile>();
    const queuedPending = deferred<SessionFile>();
    api.upload
      .mockReturnValueOnce(oldPending.promise)
      .mockReturnValueOnce(currentPending.promise)
      .mockReturnValueOnce(queuedPending.promise);

    act(() => {
      void result.current.upload([new File(["old"], "old.txt")]);
    });
    rerender({ owner: "s2" });
    await waitFor(() =>
      expect(api.list.mock.calls.some(([owner]) => owner === "s2")).toBe(true),
    );

    let currentBatch!: Promise<void>;
    act(() => {
      currentBatch = result.current.upload([
        new File(["current"], "current.txt"),
      ]);
    });
    expect(api.upload).toHaveBeenCalledTimes(2);

    await act(async () => {
      oldPending.resolve(makeSessionFile("old.txt"));
      await Promise.resolve();
    });
    expect(result.current.uploading).toBe(true);

    let queuedBatch!: Promise<void>;
    const queuedFile = new File(["queued"], "queued.txt");
    act(() => {
      queuedBatch = result.current.upload([queuedFile]);
    });
    expect(api.upload).toHaveBeenCalledTimes(2);

    await act(async () => {
      currentPending.resolve(makeSessionFile("current.txt"));
      await currentBatch;
    });
    expect(api.upload).toHaveBeenCalledTimes(3);
    expect(api.upload).toHaveBeenLastCalledWith("s2", queuedFile);

    await act(async () => {
      queuedPending.resolve(makeSessionFile("queued.txt"));
      await queuedBatch;
    });
    expect(result.current.uploading).toBe(false);
  });

  it("polls while a file is pending and stops once it is parsed", async () => {
    vi.useFakeTimers();
    const api = createApi();
    api.list.mockResolvedValue([
      makeSessionFile("p.txt", { parseStatus: "pending" }),
    ]);
    const { result } = renderHook(() =>
      useFileUploadController({ ownerId: "s1", api, pollIntervalMs: 1_000 }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(result.current.currentFiles[0]?.parseStatus).toBe("pending");

    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(api.list).toHaveBeenCalledTimes(2);

    api.list.mockResolvedValue([
      makeSessionFile("p.txt", { parseStatus: "parsed" }),
    ]);
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(api.list).toHaveBeenCalledTimes(3);
    expect(result.current.currentFiles[0]?.parseStatus).toBe("parsed");

    // Parsed: polling stops.
    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });
    expect(api.list).toHaveBeenCalledTimes(3);
  });
});
