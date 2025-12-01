'use client'

import React, { memo, useCallback, useEffect, useState } from 'react'
import { RiAddLine, RiBookOpenLine, RiDeleteBinLine, RiRefreshLine } from '@remixicon/react'
import { PortalSelect } from '@/app/components/base/select'
import { useChatWithHistoryContext } from '@/app/components/base/chat/chat-with-history/context'
import CreateProjectModal from './create-project-modal'
import KnowledgeModal from './knowledge-modal'

const PROJECT_LIST_API = 'https://n8n.toho.vn/webhook/ememory/get-project-list'
const PROJECT_CREATE_API = 'https://n8n.toho.vn/webhook/ememory/create-new-project'
const PROJECT_DELETE_API = 'https://n8n.toho.vn/webhook/ememory/delete-project'
const FIELD_NAME = 'projectKey'

type ProjectItem = {
  project_code: string
}

const ProjectSelector: React.FC = () => {
  const {
    currentConversationId,
    currentConversationInputs,
    setCurrentConversationInputs,
    newConversationInputs,
    newConversationInputsRef,
    handleNewConversationInputsChange,
  } = useChatWithHistoryContext()

  const [projects, setProjects] = useState<ProjectItem[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [showKnowledgeModal, setShowKnowledgeModal] = useState(false)

  // Get current value from context
  const inputsFormValue = currentConversationId ? currentConversationInputs : newConversationInputs
  const currentValue = inputsFormValue?.[FIELD_NAME] || ''

  // Update the field in Dify context
  const updateField = useCallback((value: string) => {
    setCurrentConversationInputs({
      ...currentConversationInputs,
      [FIELD_NAME]: value,
    })
    handleNewConversationInputsChange({
      ...newConversationInputsRef.current,
      [FIELD_NAME]: value,
    })
  }, [currentConversationInputs, setCurrentConversationInputs, newConversationInputsRef, handleNewConversationInputsChange])

  // Fetch projects from API
  const fetchProjects = useCallback(async () => {
    setIsLoading(true)
    try {
      const response = await fetch(PROJECT_LIST_API)
      const data = await response.json()
      if (Array.isArray(data)) {
        setProjects(data)
      }
    }
    catch (error) {
      console.error('[ProjectSelector] Failed to fetch projects:', error)
    }
    finally {
      setIsLoading(false)
    }
  }, [])

  // Create new project
  const createProject = useCallback(async (projectKey: string) => {
    setIsCreating(true)
    try {
      const response = await fetch(PROJECT_CREATE_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ project_code: projectKey }),
      })
      const data = await response.json()
      if (data) {
        // Refresh list and select the new project
        await fetchProjects()
        updateField(projectKey)
        setShowCreateModal(false)
      }
    }
    catch (error) {
      console.error('[ProjectSelector] Failed to create project:', error)
    }
    finally {
      setIsCreating(false)
    }
  }, [fetchProjects, updateField])

  // Delete project
  const deleteProject = useCallback(async (projectKey: string) => {
    if (!confirm(`Are you sure you want to delete project "${projectKey}"?`))
      return

    try {
      await fetch(PROJECT_DELETE_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ project_code: projectKey }),
      })
      // Clear selection if deleted project was selected
      if (currentValue === projectKey)
        updateField('')
      // Refresh list
      await fetchProjects()
    }
    catch (error) {
      console.error('[ProjectSelector] Failed to delete project:', error)
    }
  }, [currentValue, fetchProjects, updateField])

  useEffect(() => {
    fetchProjects()
  }, [fetchProjects])

  // Build select items from API projects with delete button
  const selectItems = projects.map(p => ({
    value: p.project_code,
    name: p.project_code,
    extra: (
      <div
        onClick={(e) => {
          e.stopPropagation()
          deleteProject(p.project_code)
        }}
        className='ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-state-destructive-hover'
        title={`Delete ${p.project_code}`}
      >
        <RiDeleteBinLine className='h-3.5 w-3.5 text-text-tertiary hover:text-text-destructive' />
      </div>
    ),
  }))

  const handleSelect = useCallback((item: { value: string | number; name: string }) => {
    updateField(item.value as string)
  }, [updateField])

  return (
    <>
      <PortalSelect
        popupClassName='z-50 w-[200px]'
        value={currentValue}
        items={selectItems}
        onSelect={handleSelect}
        placeholder={isLoading ? 'Loading...' : 'Select project'}
        renderTrigger={() => (
          <div className='group flex h-9 w-full cursor-pointer items-center justify-between rounded-lg border-0 bg-components-input-bg-normal px-2.5 text-sm hover:bg-state-base-hover-alt'>
            <span className={`grow truncate text-left ${!currentValue ? 'text-components-input-text-placeholder' : 'text-text-secondary'}`}>
              {currentValue || (isLoading ? 'Loading...' : 'Select project')}
            </span>
            <div className='flex items-center gap-0.5'>
              <div
                onClick={(e) => {
                  e.stopPropagation()
                  setShowKnowledgeModal(true)
                }}
                className='flex h-6 w-6 items-center justify-center rounded hover:bg-state-base-hover'
                title='Open Knowledge Base'
              >
                <RiBookOpenLine className='h-4 w-4 text-text-tertiary' />
              </div>
              <div
                onClick={(e) => {
                  e.stopPropagation()
                  setShowCreateModal(true)
                }}
                className='flex h-6 w-6 items-center justify-center rounded hover:bg-state-base-hover'
                title='Create new project'
              >
                <RiAddLine className='h-4 w-4 text-text-tertiary' />
              </div>
              <div
                onClick={(e) => {
                  e.stopPropagation()
                  fetchProjects()
                }}
                className='flex h-6 w-6 items-center justify-center rounded hover:bg-state-base-hover'
                title='Refresh projects'
              >
                <RiRefreshLine className={`h-4 w-4 text-text-tertiary ${isLoading ? 'animate-spin' : ''}`} />
              </div>
            </div>
          </div>
        )}
      />
      <CreateProjectModal
        isShow={showCreateModal}
        isLoading={isCreating}
        onClose={() => setShowCreateModal(false)}
        onSave={createProject}
      />
      <KnowledgeModal
        isShow={showKnowledgeModal}
        projectKey={currentValue}
        onClose={() => setShowKnowledgeModal(false)}
      />
    </>
  )
}

export default memo(ProjectSelector)
