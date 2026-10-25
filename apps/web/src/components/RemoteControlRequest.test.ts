import { createSSRApp } from 'vue';
import { renderToString } from '@vue/server-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Participant } from 'livekit-client';
import RemoteControlRequest from './RemoteControlRequest.vue';
import ParticipantCard from './ParticipantCard.vue';

afterEach(() => vi.unstubAllGlobals());

describe('远控确认与私密展示', () => {
  it('默认公开，显示范围说明；未取得显示器之前不能接受，准备中仍可以取消', async () => {
    vi.stubGlobal('document', { activeElement: null });
    vi.stubGlobal('HTMLElement', class {});
    const html = await renderToString(createSSRApp(RemoteControlRequest, { name: '好友', busy: false }));
    expect(html).toContain('role="dialog"');
    expect(html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0]).toContain('checked');
    expect(html).toContain('频道成员可以观看，但只有申请者能够控制');
    expect(html.match(/<button[^>]*class="confirm-button"[^>]*>/)?.[0]).toContain('disabled');
    expect(html.indexOf('>拒绝</button>')).toBeLessThan(html.indexOf('>接受并共享</button>'));
    const busy = await renderToString(createSSRApp(RemoteControlRequest, { name: '好友', busy: true }));
    expect(busy).toContain('>取消准备</button>');
    expect(busy).toContain('正在准备远程控制');
  });

  it('未共享成员也有申请入口；私密状态不渲染视频或沿用上一帧背景', async () => {
    const participant = { identity: 'target', name: '好友', isMicrophoneEnabled: false,
      isScreenShareEnabled: false, getTrackPublication: () => undefined } as unknown as Participant;
    const props = { participant, revision: 0, isLocal: false, isListening: true, remoteControlAvailable: true };
    const idle = await renderToString(createSSRApp(ParticipantCard, props));
    expect(idle).toContain('申请远程控制');
    expect(idle).not.toContain('<video');
    const privateView = await renderToString(createSSRApp(ParticipantCard, {
      ...props, participant: { ...participant, isScreenShareEnabled: true }, privateControl: '正在被另一位好友控制中',
    }));
    expect(privateView).toContain('正在被另一位好友控制中');
    expect(privateView).toContain('画面未公开');
    expect(privateView).not.toContain('<video');
    expect(privateView).not.toContain('聚焦好友的共享画面');
  });
});
