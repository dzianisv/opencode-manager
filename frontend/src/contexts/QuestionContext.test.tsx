import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { ReactNode } from 'react'
import { QuestionProvider, useQuestionContext, questionEvents } from './QuestionContext'

vi.mock('@/config', () => ({
  API_BASE_URL: 'http://localhost:5001',
}))

const mockFetch = vi.fn()
globalThis.fetch = mockFetch

function createWrapper() {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QuestionProvider>{children}</QuestionProvider>
  }
}

function makeQuestion(overrides: Record<string, unknown> = {}) {
  return {
    id: 'q-1',
    sessionID: 'sess-1',
    directory: '/test/dir',
    questions: [
      {
        question: 'Install Rust?',
        header: 'Dependencies',
        options: [
          { label: 'Yes, install Rust', description: 'Installs via rustup' },
          { label: 'No, skip', description: 'Skip installation' },
        ],
        multiple: false,
        custom: false,
      },
    ],
    tool: { messageID: 'msg-1', callID: 'call-1' },
    ...overrides,
  }
}

describe('QuestionContext', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockResolvedValue({ ok: true, json: async () => [] })
    questionEvents.listeners.clear()
  })

  afterEach(() => {
    questionEvents.listeners.clear()
  })

  it('should throw when used outside provider', () => {
    expect(() => {
      renderHook(() => useQuestionContext())
    }).toThrow('useQuestionContext must be used within QuestionProvider')
  })

  it('should start with no pending questions', () => {
    const { result } = renderHook(() => useQuestionContext(), {
      wrapper: createWrapper(),
    })

    expect(result.current.pendingQuestions).toEqual([])
    expect(result.current.currentQuestion).toBeNull()
    expect(result.current.isDialogDismissed).toBe(false)
  })

  it('should add a question via addQuestion', () => {
    const { result } = renderHook(() => useQuestionContext(), {
      wrapper: createWrapper(),
    })

    act(() => {
      result.current.addQuestion(makeQuestion())
    })

    expect(result.current.pendingQuestions).toHaveLength(1)
    expect(result.current.currentQuestion?.id).toBe('q-1')
  })

  it('should not add duplicate questions', () => {
    const { result } = renderHook(() => useQuestionContext(), {
      wrapper: createWrapper(),
    })

    act(() => {
      result.current.addQuestion(makeQuestion())
      result.current.addQuestion(makeQuestion())
    })

    expect(result.current.pendingQuestions).toHaveLength(1)
  })

  it('should remove a question via removeQuestion', () => {
    const { result } = renderHook(() => useQuestionContext(), {
      wrapper: createWrapper(),
    })

    act(() => {
      result.current.addQuestion(makeQuestion())
    })
    expect(result.current.pendingQuestions).toHaveLength(1)

    act(() => {
      result.current.removeQuestion('q-1')
    })
    expect(result.current.pendingQuestions).toHaveLength(0)
    expect(result.current.currentQuestion).toBeNull()
  })

  it('should not re-add a question that was already answered', () => {
    const { result } = renderHook(() => useQuestionContext(), {
      wrapper: createWrapper(),
    })

    act(() => {
      result.current.addQuestion(makeQuestion())
    })
    act(() => {
      result.current.removeQuestion('q-1')
    })
    act(() => {
      result.current.addQuestion(makeQuestion())
    })

    expect(result.current.pendingQuestions).toHaveLength(0)
  })

  it('should respond to a question via API', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] })
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'ok' })

    const { result } = renderHook(() => useQuestionContext(), {
      wrapper: createWrapper(),
    })

    act(() => {
      result.current.addQuestion(makeQuestion())
    })

    await act(async () => {
      await result.current.respondToQuestion('q-1', [['Yes, install Rust']])
    })

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:5001/api/opencode/question/q-1/reply?directory=%2Ftest%2Fdir',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers: [['Yes, install Rust']] }),
      })
    )
    expect(result.current.pendingQuestions).toHaveLength(0)
  })

  it('should throw when responding to a nonexistent question', async () => {
    const { result } = renderHook(() => useQuestionContext(), {
      wrapper: createWrapper(),
    })

    await expect(
      act(async () => {
        await result.current.respondToQuestion('nonexistent', [['Yes']])
      })
    ).rejects.toThrow('Question not found')
  })

  it('should throw when API returns error on respond', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] })
    mockFetch.mockResolvedValueOnce({ ok: false, text: async () => 'Server error' })

    const { result } = renderHook(() => useQuestionContext(), {
      wrapper: createWrapper(),
    })

    act(() => {
      result.current.addQuestion(makeQuestion())
    })

    await expect(
      act(async () => {
        await result.current.respondToQuestion('q-1', [['Yes, install Rust']])
      })
    ).rejects.toThrow('Failed to respond to question: Server error')
  })

  it('should reject a question via API', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] })
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'ok' })

    const { result } = renderHook(() => useQuestionContext(), {
      wrapper: createWrapper(),
    })

    act(() => {
      result.current.addQuestion(makeQuestion())
    })

    await act(async () => {
      await result.current.rejectQuestion('q-1')
    })

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:5001/api/opencode/question/q-1/reject?directory=%2Ftest%2Fdir',
      expect.objectContaining({ method: 'POST' })
    )
    expect(result.current.pendingQuestions).toHaveLength(0)
  })

  it('should dismiss dialog without rejecting the question', () => {
    const { result } = renderHook(() => useQuestionContext(), {
      wrapper: createWrapper(),
    })

    act(() => {
      result.current.addQuestion(makeQuestion())
    })

    act(() => {
      result.current.dismissDialog()
    })

    expect(result.current.isDialogDismissed).toBe(true)
    expect(result.current.pendingQuestions).toHaveLength(1)
    expect(result.current.currentQuestion?.id).toBe('q-1')
  })

  it('should reset isDialogDismissed when a new question is added', () => {
    const { result } = renderHook(() => useQuestionContext(), {
      wrapper: createWrapper(),
    })

    act(() => {
      result.current.addQuestion(makeQuestion())
    })
    act(() => {
      result.current.dismissDialog()
    })
    expect(result.current.isDialogDismissed).toBe(true)

    act(() => {
      result.current.addQuestion(makeQuestion({ id: 'q-2' }))
    })
    expect(result.current.isDialogDismissed).toBe(false)
  })

  it('should queue multiple questions and expose first as currentQuestion', () => {
    const { result } = renderHook(() => useQuestionContext(), {
      wrapper: createWrapper(),
    })

    act(() => {
      result.current.addQuestion(makeQuestion({ id: 'q-1' }))
      result.current.addQuestion(makeQuestion({ id: 'q-2' }))
    })

    expect(result.current.pendingQuestions).toHaveLength(2)
    expect(result.current.currentQuestion?.id).toBe('q-1')
  })

  it('should use sessionID as directory fallback when directory is missing', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] })
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => 'ok' })

    const { result } = renderHook(() => useQuestionContext(), {
      wrapper: createWrapper(),
    })

    act(() => {
      result.current.addQuestion(makeQuestion({ directory: undefined }))
    })

    await act(async () => {
      await result.current.respondToQuestion('q-1', [['Yes, install Rust']])
    })

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:5001/api/opencode/question/q-1/reply?directory=sess-1',
      expect.anything()
    )
  })
})

describe('questionEvents', () => {
  afterEach(() => {
    questionEvents.listeners.clear()
  })

  it('should emit to subscribers', () => {
    const listener = vi.fn()
    questionEvents.subscribe(listener)

    const q = makeQuestion()
    questionEvents.emit(q)

    expect(listener).toHaveBeenCalledWith(q)
  })

  it('should unsubscribe correctly', () => {
    const listener = vi.fn()
    const unsub = questionEvents.subscribe(listener)
    unsub()

    questionEvents.emit(makeQuestion())

    expect(listener).not.toHaveBeenCalled()
  })

  it('should support multiple subscribers', () => {
    const listener1 = vi.fn()
    const listener2 = vi.fn()
    questionEvents.subscribe(listener1)
    questionEvents.subscribe(listener2)

    questionEvents.emit(makeQuestion())

    expect(listener1).toHaveBeenCalled()
    expect(listener2).toHaveBeenCalled()
  })
})
