'use client'
import type { FC } from 'react'
import {
  useEffect,
  useState,
} from 'react'
import { useThemeContext } from '../embedded-chatbot/theme/theme-context'
import {
  ChatWithHistoryContext,
  useChatWithHistoryContext,
} from './context'
import { useChatWithHistory } from './hooks'
import Sidebar from './sidebar'
import Header from './header'
import HeaderInMobile from './header-in-mobile'
import ChatWrapper from './chat-wrapper'
import type { InstalledApp } from '@/models/explore'
import Loading from '@/app/components/base/loading'
import useBreakpoints, { MediaType } from '@/hooks/use-breakpoints'
import cn from '@/utils/classnames'
import useDocumentTitle from '@/hooks/use-document-title'
import PdfViewerWithHighlight from './pdf-viewer-with-highlight'

type ChatWithHistoryProps = {
  className?: string
}
const ChatWithHistory: FC<ChatWithHistoryProps> = ({
  className,
}) => {
  const {
    appData,
    appChatListDataLoading,
    chatShouldReloadKey,
    isMobile,
    themeBuilder,
    sidebarCollapseState,
    previewData,
    setPreviewData,
  } = useChatWithHistoryContext()
  const isSidebarCollapsed = sidebarCollapseState
  const customConfig = appData?.custom_config
  const site = appData?.site

  const [showSidePanel, setShowSidePanel] = useState(false)

  useEffect(() => {
    themeBuilder?.buildTheme(site?.chat_color_theme, site?.chat_color_theme_inverted)
  }, [site, customConfig, themeBuilder])

  useEffect(() => {
    if (!isSidebarCollapsed)
      setShowSidePanel(false)
  }, [isSidebarCollapsed])

  useDocumentTitle(site?.title || 'Chat')

  return (
    <div className={cn(
      'flex h-full bg-background-default-burn',
      isMobile && 'flex-col',
      className,
    )}>
      {!isMobile && (
        <div className={cn(
          'flex w-[236px] flex-col p-1 pr-0 transition-all duration-200 ease-in-out',
          isSidebarCollapsed && 'w-0 overflow-hidden !p-0',
        )}>
          <Sidebar />
        </div>
      )}
      {isMobile && (
        <HeaderInMobile />
      )}
      <div className={cn('relative grow p-2', isMobile && 'h-[calc(100%_-_56px)] p-0')}>
        {isSidebarCollapsed && (
          <div
            className={cn(
              'absolute top-0 z-20 flex h-full w-[256px] flex-col p-2 transition-all duration-500 ease-in-out',
              showSidePanel ? 'left-0' : 'left-[-248px]',
            )}
            onMouseEnter={() => setShowSidePanel(true)}
            onMouseLeave={() => setShowSidePanel(false)}
          >
            <Sidebar isPanel panelVisible={showSidePanel} />
          </div>
        )}
        <div className={cn('flex h-full flex-col overflow-hidden border-[0,5px] border-components-panel-border-subtle bg-chatbot-bg', isMobile ? 'rounded-t-2xl' : 'rounded-2xl')}>
          {!isMobile && <Header />}
          {appChatListDataLoading && (
            <Loading type='app' />
          )}
          {!appChatListDataLoading && (
            <ChatWrapper key={chatShouldReloadKey} />
          )}
        </div>
      </div>
      {!isMobile && previewData && (
        <div className='flex w-[400px] flex-col p-2 pl-0 transition-all duration-200 ease-in-out'>
          <div className='flex h-full w-full flex-col rounded-xl border-[0.5px] border-components-panel-border-subtle bg-components-panel-bg shadow-lg'>
            {/* Header */}
            <div className='flex h-12 shrink-0 items-center justify-between border-b border-components-panel-border-subtle px-4'>
              <span className='system-md-semibold truncate text-text-secondary'>
                File Preview
              </span>
              <div className='flex items-center gap-1'>
                <a
                  href={previewData.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className='flex h-8 w-8 items-center justify-center rounded-lg hover:bg-state-base-hover'
                  title="Open in new tab"
                >
                  <svg className='h-4 w-4' fill='none' stroke='currentColor' viewBox='0 0 24 24'>
                    <path strokeLinecap='round' strokeLinejoin='round' strokeWidth={2} d='M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14' />
                  </svg>
                </a>
                <button
                  onClick={() => setPreviewData(null)}
                  className='flex h-8 w-8 items-center justify-center rounded-lg hover:bg-state-base-hover'
                  title="Close"
                >
                  <svg className='h-4 w-4' fill='none' stroke='currentColor' viewBox='0 0 24 24'>
                    <path strokeLinecap='round' strokeLinejoin='round' strokeWidth={2} d='M6 18L18 6M6 6l12 12' />
                  </svg>
                </button>
              </div>
            </div>
            {/* Content */}
            <div className='flex-1 overflow-hidden p-4'>
              {/* File info */}
              {previewData.filename && (
                <div className='mb-2 text-xs font-medium text-text-secondary'>
                  File Name: {previewData.filename}
                </div>
              )}
              {(previewData.pageNumber || previewData.chunkId) && (
                <div className='mb-3 text-xs text-text-tertiary'>
                  {previewData.pageNumber && <span>Page {previewData.pageNumber}</span>}
                  {previewData.pageNumber && previewData.chunkId && <span> - </span>}
                  {previewData.chunkId && <span>Chunk {previewData.chunkId}</span>}
                </div>
              )}
              {/* Source text citation */}
              {(previewData.fullText || previewData.sourceText) && (
                <div className='bg-background-default-dimm mb-4 rounded-lg border border-divider-subtle p-3'>
                  <div className='mb-2 text-xs font-medium text-text-tertiary'>Source Text</div>
                  <div className='text-sm text-text-secondary'>
                    {previewData.fullText || previewData.sourceText}
                  </div>
                </div>
              )}
              {/* Image preview */}
              {/\.(png|jpg|jpeg|gif|webp|svg)$/i.test(previewData.url) && (
                <img
                  src={previewData.url}
                  alt="Preview"
                  className='max-w-full rounded-lg'
                />
              )}
              {/* PDF preview with highlighting */}
              {/\.pdf(#|$)/i.test(previewData.url) && (
                <div className='relative h-full min-h-[600px] w-full overflow-hidden rounded-lg'>
                  <PdfViewerWithHighlight
                    url={previewData.url}
                    searchText={previewData.sourceText}
                    pageNumber={previewData.pageNumber}
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export type ChatWithHistoryWrapProps = {
  installedAppInfo?: InstalledApp
  className?: string
}
const ChatWithHistoryWrap: FC<ChatWithHistoryWrapProps> = ({
  installedAppInfo,
  className,
}) => {
  const media = useBreakpoints()
  const isMobile = media === MediaType.mobile
  const themeBuilder = useThemeContext()
  const [previewData, setPreviewData] = useState<{ url: string; sourceText?: string; pageNumber?: string; filename?: string; chunkId?: string; fullText?: string } | null>(null)

  const {
    appData,
    appParams,
    appMeta,
    appChatListDataLoading,
    currentConversationId,
    currentConversationItem,
    appPrevChatTree,
    pinnedConversationList,
    conversationList,
    newConversationInputs,
    newConversationInputsRef,
    handleNewConversationInputsChange,
    inputsForms,
    handleNewConversation,
    handleStartChat,
    handleChangeConversation,
    handlePinConversation,
    handleUnpinConversation,
    handleDeleteConversation,
    conversationRenaming,
    handleRenameConversation,
    handleNewConversationCompleted,
    chatShouldReloadKey,
    isInstalledApp,
    appId,
    handleFeedback,
    currentChatInstanceRef,
    sidebarCollapseState,
    handleSidebarCollapse,
    clearChatList,
    setClearChatList,
    isResponding,
    setIsResponding,
    currentConversationInputs,
    setCurrentConversationInputs,
    allInputsHidden,
    initUserVariables,
  } = useChatWithHistory(installedAppInfo)

  return (
    <ChatWithHistoryContext.Provider value={{
      appData,
      appParams,
      appMeta,
      appChatListDataLoading,
      currentConversationId,
      currentConversationItem,
      appPrevChatTree,
      pinnedConversationList,
      conversationList,
      newConversationInputs,
      newConversationInputsRef,
      handleNewConversationInputsChange,
      inputsForms,
      handleNewConversation,
      handleStartChat,
      handleChangeConversation,
      handlePinConversation,
      handleUnpinConversation,
      handleDeleteConversation,
      conversationRenaming,
      handleRenameConversation,
      handleNewConversationCompleted,
      chatShouldReloadKey,
      isMobile,
      isInstalledApp,
      appId,
      handleFeedback,
      currentChatInstanceRef,
      themeBuilder,
      sidebarCollapseState,
      handleSidebarCollapse,
      clearChatList,
      setClearChatList,
      isResponding,
      setIsResponding,
      currentConversationInputs,
      setCurrentConversationInputs,
      allInputsHidden,
      initUserVariables,
      previewData,
      setPreviewData,
    }}>
      <ChatWithHistory className={className} />
    </ChatWithHistoryContext.Provider>
  )
}

const ChatWithHistoryWrapWithCheckToken: FC<ChatWithHistoryWrapProps> = ({
  installedAppInfo,
  className,
}) => {
  return (
    <ChatWithHistoryWrap
      installedAppInfo={installedAppInfo}
      className={className}
    />
  )
}

export default ChatWithHistoryWrapWithCheckToken
