/**
 * clickNode 的 userGesture 验证：确保 Runtime.callFunctionOn 携带 userGesture: true，
 * 让 window.open 等受用户手势保护的 API 能正常工作。
 *
 * 背景：42304 迭代里 openTab 调用 window.open 失败，因为 CLI DOM click 的
 * Runtime.callFunctionOn 未携带 userGesture，导致 userActiveBefore=false、returnedWindow=false。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { clickNode, callOnNode } from '../interactions.js';

describe('clickNode userGesture', () => {
  let mockSession: any;
  let sentCommands: Array<{ method: string; params: any }>;

  beforeEach(() => {
    sentCommands = [];
    mockSession = {
      send: async (method: string, params: any) => {
        sentCommands.push({ method, params });
        // DOM.resolveNode 返回 objectId
        if (method === 'DOM.resolveNode') {
          return { object: { objectId: 'test-object-id' } };
        }
        // DOM.scrollIntoViewIfNeeded 成功
        if (method === 'DOM.scrollIntoViewIfNeeded') {
          return {};
        }
        if (method === 'DOM.getContentQuads') {
          return { quads: [[10, 10, 20, 10, 20, 20, 10, 20]] };
        }
        if (method === 'Page.getLayoutMetrics') {
          return { cssVisualViewport: { pageX: 0, pageY: 0 } };
        }
        if (method === 'DOM.getNodeForLocation') return { backendNodeId: 123 };
        // Runtime.callFunctionOn 返回成功（无异常）
        if (method === 'Runtime.callFunctionOn') {
          return { result: { value: undefined } };
        }
        return {};
      },
    };
  });

  it('clickNode 正常点击：Input.dispatchMouseEvent 使用真实坐标', async () => {
    await clickNode(mockSession, 123);
    const mouseCalls = sentCommands.filter((c) => c.method === 'Input.dispatchMouseEvent');
    expect(mouseCalls.map((c) => c.params.type)).toEqual(['mousePressed', 'mouseReleased']);
    for (const call of mouseCalls) {
      expect(call.params.x).toBe(15);
      expect(call.params.y).toBe(15);
      expect(call.params.button).toBe('left');
    }
  });

  it('clickNode dispatch 失败：失败输入命令不再继续释放', async () => {
    let dispatchCount = 0;
    mockSession.send = async (method: string, params: any) => {
      sentCommands.push({ method, params });
      if (method === 'DOM.resolveNode') {
        return { object: { objectId: 'test-object-id' } };
      }
      if (method === 'DOM.getContentQuads') {
        return { quads: [[10, 10, 20, 10, 20, 20, 10, 20]] };
      }
      if (method === 'Page.getLayoutMetrics') {
        return { cssVisualViewport: { pageX: 0, pageY: 0 } };
      }
      if (method === 'DOM.getNodeForLocation') return { backendNodeId: 123 };
      if (method === 'DOM.scrollIntoViewIfNeeded') {
        return {};
      }
      if (method === 'Input.dispatchMouseEvent') {
        if (++dispatchCount === 1) throw new Error('Input dispatch failed');
        return {};
      }
      if (method === 'Runtime.callFunctionOn') {
        return { result: { value: undefined } };
      }
      return {};
    };

    await expect(clickNode(mockSession, 123)).rejects.toThrow('Input dispatch failed');
    const mouseCalls = sentCommands.filter((c) => c.method === 'Input.dispatchMouseEvent');
    expect(mouseCalls).toHaveLength(1);
    expect(mouseCalls[0].params.type).toBe('mousePressed');
  });

  it('clickNode 命中探测使用整型 page 坐标，指针保留浮点 viewport 坐标', async () => {
    mockSession.send = async (method: string, params: any) => {
      sentCommands.push({ method, params });
      if (method === 'DOM.resolveNode') return { object: { objectId: 'test-object-id' } };
      if (method === 'DOM.getContentQuads') return { quads: [[168.8125, 396.71875, 188.8125, 396.71875, 188.8125, 416.71875, 168.8125, 416.71875]] };
      if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { pageX: 0, pageY: 3134 } };
      if (method === 'DOM.getNodeForLocation') return { backendNodeId: 123 };
      if (method === 'Runtime.callFunctionOn') return { result: { value: undefined } };
      return {};
    };

    await clickNode(mockSession, 123);

    const probe = sentCommands.find((call) => call.method === 'DOM.getNodeForLocation');
    expect(probe?.params).toEqual({ x: 179, y: 3541 });
    const mouseCalls = sentCommands.filter((call) => call.method === 'Input.dispatchMouseEvent');
    expect(mouseCalls.map((call) => ({ x: call.params.x, y: call.params.y }))).toEqual([
      { x: 178.8125, y: 406.71875 },
      { x: 178.8125, y: 406.71875 },
    ]);
  });

  it('clickNode 命中探测 CDP 异常：返回稳定 NOT_INTERACTABLE 并带坐标与原因', async () => {
    mockSession.send = async (method: string, params: any) => {
      sentCommands.push({ method, params });
      if (method === 'DOM.resolveNode') return { object: { objectId: 'test-object-id' } };
      if (method === 'DOM.getContentQuads') return { quads: [[80, 407, 100, 407, 100, 427, 80, 427]] };
      if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { pageX: 0, pageY: 3133 } };
      if (method === 'DOM.getNodeForLocation') throw new Error('CDP error: No node');
      if (method === 'Runtime.callFunctionOn') return { result: { value: undefined } };
      return {};
    };

    await expect(clickNode(mockSession, 123)).rejects.toThrow(
      'NOT_INTERACTABLE: 点击坐标 (viewport=90,417; page=90,3550) 命中探测失败: CDP error: No node',
    );
  });

  it('普通 callOnNode 默认不带 userGesture（false）', async () => {
    await callOnNode(mockSession, 123, 'function() { return 42; }');

    const cfoCalls = sentCommands.filter((c) => c.method === 'Runtime.callFunctionOn');
    expect(cfoCalls.length).toBe(1);
    expect(cfoCalls[0].params.userGesture).toBe(false);
  });

  it('callOnNode 显式传 false：userGesture 为 false', async () => {
    await callOnNode(mockSession, 123, 'function() { return 42; }', [], false);

    const cfoCalls = sentCommands.filter((c) => c.method === 'Runtime.callFunctionOn');
    expect(cfoCalls.length).toBe(1);
    expect(cfoCalls[0].params.userGesture).toBe(false);
  });

  it('callOnNode 显式传 true：userGesture 为 true', async () => {
    await callOnNode(mockSession, 123, 'function() { return 42; }', [], true);

    const cfoCalls = sentCommands.filter((c) => c.method === 'Runtime.callFunctionOn');
    expect(cfoCalls.length).toBe(1);
    expect(cfoCalls[0].params.userGesture).toBe(true);
  });
});
