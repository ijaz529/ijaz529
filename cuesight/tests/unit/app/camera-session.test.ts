import { describe, expect, it } from 'vitest';
import { createCameraSession, startCamera, type VideoSink } from '../../../src/app/camera';

class FakeTrack {
  readyState: 'live' | 'ended' = 'live';
  kind = 'video';
  stop(): void {
    this.readyState = 'ended';
  }
}
class FakeStream {
  tracks = [new FakeTrack()];
  getTracks() {
    return this.tracks;
  }
  getVideoTracks() {
    return this.tracks;
  }
}

/** A video element whose play() is aborted when its source changes before it starts (like browsers do). */
class FakeVideo implements VideoSink {
  muted = false;
  playsInline = false;
  private src: MediaStream | null = null;
  private playing: { reject: (e: unknown) => void } | null = null;
  playDelay = true;
  get srcObject(): MediaStream | null {
    return this.src;
  }
  set srcObject(s: MediaStream | null) {
    this.src = s;
    if (this.playing) {
      this.playing.reject(Object.assign(new Error('The play() request was interrupted'), { name: 'AbortError' }));
      this.playing = null;
    }
  }
  play(): Promise<void> {
    if (!this.playDelay) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.playing = { reject };
      setTimeout(() => {
        if (this.playing?.reject === reject) {
          this.playing = null;
          resolve();
        }
      }, 5);
    });
  }
}

/** getUserMedia that resolves only when the test says so. */
function deferredGum() {
  const calls: { resolve: () => FakeStream; reject: (e: unknown) => void }[] = [];
  const streams: FakeStream[] = [];
  const gum = () =>
    new Promise<MediaStream>((res, rej) => {
      calls.push({
        resolve: () => {
          const s = new FakeStream();
          streams.push(s);
          res(s as unknown as MediaStream);
          return s;
        },
        reject: rej,
      });
    });
  const live = () => streams.flatMap((s) => s.tracks).filter((t) => t.readyState === 'live').length;
  return { gum, calls, streams, live };
}
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

describe('camera session: overlapping starts never leave a second stream running', () => {
  it('start → stop before getUserMedia resolves: the late stream is stopped, the start is stale', async () => {
    const g = deferredGum();
    const video = new FakeVideo();
    const cam = createCameraSession(video, g.gum);
    const p = cam.start();
    cam.stop();
    g.calls[0]!.resolve();
    expect((await p).kind).toBe('stale');
    expect(g.live()).toBe(0);
    expect(video.srcObject).toBeNull();
  });

  it('start → stop → start, overlapping: exactly one live track at the end', async () => {
    const g = deferredGum();
    const video = new FakeVideo();
    const cam = createCameraSession(video, g.gum);
    const p1 = cam.start();
    cam.stop();
    const p2 = cam.start();
    const second = g.calls[1]!.resolve();
    await tick();
    g.calls[0]!.resolve(); // the first, abandoned request resolves last
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.kind).toBe('stale');
    expect(r2.kind).toBe('started');
    expect(g.live()).toBe(1);
    expect(video.srcObject).toBe(second);
    expect(cam.active()).toBe(true);
  });

  it('a double start asks for the camera once', async () => {
    const g = deferredGum();
    const cam = createCameraSession(new FakeVideo(), g.gum);
    const p1 = cam.start();
    const p2 = cam.start();
    expect(g.calls.length).toBe(1);
    g.calls[0]!.resolve();
    expect((await p1).kind).toBe('started');
    expect((await p2).kind).toBe('started');
    // Already running: no new request either.
    expect((await cam.start()).kind).toBe('started');
    expect(g.calls.length).toBe(1);
    expect(g.live()).toBe(1);
  });

  it('stop during play(): no error surfaces and nothing keeps capturing', async () => {
    const g = deferredGum();
    const video = new FakeVideo();
    const cam = createCameraSession(video, g.gum);
    const p = cam.start();
    g.calls[0]!.resolve();
    for (let i = 0; i < 20 && !video.srcObject; i++) await Promise.resolve();
    expect(video.srcObject).toBe(g.streams[0]); // attached: now inside play()
    cam.stop();
    expect((await p).kind).toBe('stale');
    expect(g.live()).toBe(0);
  });

  it('a real failure is reported (and leaves nothing running); a later start retries', async () => {
    const g = deferredGum();
    const cam = createCameraSession(new FakeVideo(), g.gum);
    const p = cam.start();
    g.calls[0]!.reject(Object.assign(new Error('no'), { name: 'NotAllowedError' }));
    const r = await p;
    expect(r.kind).toBe('error');
    expect(r.kind === 'error' && (r.error as { name: string }).name).toBe('NotAllowedError');
    const p2 = cam.start();
    expect(g.calls.length).toBe(2);
    g.calls[1]!.resolve();
    expect((await p2).kind).toBe('started');
  });

  it('a stream whose track ended is restarted', async () => {
    const g = deferredGum();
    const cam = createCameraSession(new FakeVideo(), g.gum);
    const p = cam.start();
    g.calls[0]!.resolve();
    await p;
    g.streams[0]!.tracks[0]!.stop(); // another app took the camera
    expect(cam.active()).toBe(false);
    const p2 = cam.start();
    expect(g.calls.length).toBe(2);
    g.calls[1]!.resolve();
    expect((await p2).kind).toBe('started');
  });
});

describe('startCamera', () => {
  it('stops the stream it replaces, and its own stream when play() fails', async () => {
    const video = new FakeVideo();
    video.playDelay = false;
    const old = new FakeStream();
    video.srcObject = old as unknown as MediaStream;
    const s = new FakeStream();
    await startCamera(video, () => Promise.resolve(s as unknown as MediaStream));
    expect(old.tracks[0]!.readyState).toBe('ended');
    expect(video.srcObject).toBe(s);

    const bad = new FakeStream();
    const v2 = new FakeVideo();
    v2.play = () => Promise.reject(Object.assign(new Error('nope'), { name: 'NotAllowedError' }));
    await expect(startCamera(v2, () => Promise.resolve(bad as unknown as MediaStream))).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(bad.tracks[0]!.readyState).toBe('ended');
    expect(v2.srcObject).toBeNull();
  });
});
