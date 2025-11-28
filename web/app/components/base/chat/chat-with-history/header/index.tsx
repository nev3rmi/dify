import { useCallback, useState } from 'react'
import {
  RiCloseLine,
  RiEditBoxLine,
  RiLayoutRight2Line,
  RiResetLeftLine,
} from '@remixicon/react'
import { useTranslation } from 'react-i18next'
import {
  useChatWithHistoryContext,
} from '../context'
import Operation from './operation'
import ActionButton, { ActionButtonState } from '@/app/components/base/action-button'
import AppIcon from '@/app/components/base/app-icon'
import Tooltip from '@/app/components/base/tooltip'
import ViewFormDropdown from '@/app/components/base/chat/chat-with-history/inputs-form/view-form-dropdown'
import Confirm from '@/app/components/base/confirm'
import RenameModal from '@/app/components/base/chat/chat-with-history/sidebar/rename-modal'
import type { ConversationItem } from '@/models/share'
import cn from '@/utils/classnames'

const Header = () => {
  const {
    appData,
    currentConversationId,
    currentConversationItem,
    inputsForms,
    pinnedConversationList,
    handlePinConversation,
    handleUnpinConversation,
    conversationRenaming,
    handleRenameConversation,
    handleDeleteConversation,
    handleNewConversation,
    sidebarCollapseState,
    handleSidebarCollapse,
    isResponding,
    previewData,
    setPreviewData,
  } = useChatWithHistoryContext()
  const { t } = useTranslation()
  const isSidebarCollapsed = sidebarCollapseState

  const isPin = pinnedConversationList.some(item => item.id === currentConversationId)

  const [showConfirm, setShowConfirm] = useState<ConversationItem | null>(null)
  const [showRename, setShowRename] = useState<ConversationItem | null>(null)
  const [showCustomPanel, setShowCustomPanel] = useState(false)
  const handleOperate = useCallback((type: string) => {
    if (type === 'pin')
      handlePinConversation(currentConversationId)

    if (type === 'unpin')
      handleUnpinConversation(currentConversationId)

    if (type === 'delete')
      setShowConfirm(currentConversationItem as any)

    if (type === 'rename')
      setShowRename(currentConversationItem as any)
  }, [currentConversationId, currentConversationItem, handlePinConversation, handleUnpinConversation])
  const handleCancelConfirm = useCallback(() => {
    setShowConfirm(null)
  }, [])
  const handleDelete = useCallback(() => {
    if (showConfirm)
      handleDeleteConversation(showConfirm.id, { onSuccess: handleCancelConfirm })
  }, [showConfirm, handleDeleteConversation, handleCancelConfirm])
  const handleCancelRename = useCallback(() => {
    setShowRename(null)
  }, [])
  const handleRename = useCallback((newName: string) => {
    if (showRename)
      handleRenameConversation(showRename.id, newName, { onSuccess: handleCancelRename })
  }, [showRename, handleRenameConversation, handleCancelRename])

  return (
    <>
      <div className='flex h-14 shrink-0 items-center justify-between p-3'>
        <div className={cn('flex items-center gap-1 transition-all duration-200 ease-in-out', !isSidebarCollapsed && 'user-select-none opacity-0')}>
          <ActionButton className={cn(!isSidebarCollapsed && 'cursor-default')} size='l' onClick={() => handleSidebarCollapse(false)}>
            <RiLayoutRight2Line className='h-[18px] w-[18px]' />
          </ActionButton>
          <div className='mr-1 shrink-0'>
            <AppIcon
              size='large'
              iconType={appData?.site.icon_type}
              icon={appData?.site.icon}
              background={appData?.site.icon_background}
              imageUrl={appData?.site.icon_url}
            />
          </div>
          {!currentConversationId && (
            <div className={cn('system-md-semibold grow truncate text-text-secondary')}>{appData?.site.title}</div>
          )}
          {currentConversationId && currentConversationItem && isSidebarCollapsed && (
            <>
              <div className='p-1 text-divider-deep'>/</div>
              <Operation
                title={currentConversationItem?.name || ''}
                isPinned={!!isPin}
                togglePin={() => handleOperate(isPin ? 'unpin' : 'pin')}
                isShowDelete
                isShowRenameConversation
                onRenameConversation={() => handleOperate('rename')}
                onDelete={() => handleOperate('delete')}
              />
            </>
          )}
          <div className='flex items-center px-1'>
            <div className='h-[14px] w-px bg-divider-regular'></div>
          </div>
          {isSidebarCollapsed && (
            <Tooltip
              disabled={!!currentConversationId}
              popupContent={t('share.chat.newChatTip')}
            >
              <div>
                <ActionButton
                  size='l'
                  state={(!currentConversationId || isResponding) ? ActionButtonState.Disabled : ActionButtonState.Default}
                  disabled={!currentConversationId || isResponding}
                  onClick={handleNewConversation}
                >
                  <RiEditBoxLine className='h-[18px] w-[18px]' />
                </ActionButton>
              </div>
            </Tooltip>
          )}
        </div>
        <div className='flex items-center gap-1'>
          {currentConversationId && (
            <Tooltip
              popupContent={t('share.chat.resetChat')}
            >
              <ActionButton size='l' onClick={handleNewConversation}>
                <RiResetLeftLine className='h-[18px] w-[18px]' />
              </ActionButton>
            </Tooltip>
          )}
          {currentConversationId && inputsForms.length > 0 && (
            <ViewFormDropdown />
          )}
          {/* Custom Panel Toggle */}
          <Tooltip popupContent="Custom Panel">
            <ActionButton
              size='l'
              state={showCustomPanel ? ActionButtonState.Active : ActionButtonState.Default}
              onClick={() => setShowCustomPanel(!showCustomPanel)}
            >
              <RiLayoutRight2Line className='h-[18px] w-[18px]' />
            </ActionButton>
          </Tooltip>
        </div>
      </div>
      {!!showConfirm && (
        <Confirm
          title={t('share.chat.deleteConversation.title')}
          content={t('share.chat.deleteConversation.content') || ''}
          isShow
          onCancel={handleCancelConfirm}
          onConfirm={handleDelete}
        />
      )}
      {showRename && (
        <RenameModal
          isShow
          onClose={handleCancelRename}
          saveLoading={conversationRenaming}
          name={showRename?.name || ''}
          onSave={handleRename}
        />
      )}
      {/* File Preview Panel */}
      {(showCustomPanel || previewData) && (
        <div className='fixed right-0 top-14 z-50 flex h-[calc(100vh-56px)] w-[400px] flex-col border-l border-divider-subtle bg-background-default-subtle shadow-lg'>
          <div className='flex h-12 shrink-0 items-center justify-between border-b border-divider-subtle px-4'>
            <span className='system-md-semibold truncate text-text-secondary'>
              {previewData ? 'File Preview' : 'Custom Panel'}
            </span>
            <ActionButton size='l' onClick={() => { setShowCustomPanel(false); setPreviewData(null) }}>
              <RiCloseLine className='h-[18px] w-[18px]' />
            </ActionButton>
          </div>
          <div className='flex-1 overflow-auto p-4'>
            {previewData ? (
              <>
                {/* Source text citation */}
                {previewData.sourceText && (
                  <div className='mb-4 rounded-lg border border-divider-subtle bg-background-default-dimm p-3'>
                    <div className='mb-2 text-xs font-medium text-text-tertiary'>Source Text</div>
                    <div className='text-sm text-text-secondary'>{previewData.sourceText}</div>
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
                {/* PDF preview */}
                {/\.pdf$/i.test(previewData.url) && (
                  <iframe
                    src={previewData.url}
                    className='h-full min-h-[600px] w-full rounded-lg border-0'
                    title="PDF Preview"
                  />
                )}
                {/* Link to original */}
                <a
                  href={previewData.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className='mt-4 block text-sm text-text-accent underline'
                >
                  Open in new tab
                </a>
              </>
            ) : (
              <p className='text-sm text-text-tertiary'>
                Click a minio.toho.vn link in chat to preview files here.
              </p>
            )}
          </div>
        </div>
      )}
    </>
  )
}

export default Header
