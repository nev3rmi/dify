import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import produce from 'immer'
import { useBoolean } from 'ahooks'
import { useStore } from '../../store'
import { type ToolNodeType, type ToolVarInputs, VarType } from './types'
import { useLanguage } from '@/app/components/header/account-setting/model-provider-page/hooks'
import useNodeCrud from '@/app/components/workflow/nodes/_base/hooks/use-node-crud'
import { CollectionType } from '@/app/components/tools/types'
import { updateBuiltInToolCredential } from '@/service/tools'
import { addDefaultValue, toolParametersToFormSchemas } from '@/app/components/tools/utils/to-form-schema'
import Toast from '@/app/components/base/toast'
import type { Props as FormProps } from '@/app/components/workflow/nodes/_base/components/before-run-form/form'
import { VarType as VarVarType } from '@/app/components/workflow/types'
import type { InputVar, ValueSelector, Var } from '@/app/components/workflow/types'
import useOneStepRun from '@/app/components/workflow/nodes/_base/hooks/use-one-step-run'
import {
  useFetchToolsData,
  useNodesReadOnly,
} from '@/app/components/workflow/hooks'

const useConfig = (id: string, payload: ToolNodeType) => {
  const { nodesReadOnly: readOnly } = useNodesReadOnly()
  const { handleFetchAllTools } = useFetchToolsData()
  const { t } = useTranslation()

  const language = useLanguage()
  const { inputs, setInputs } = useNodeCrud<ToolNodeType>(id, payload)
  /*
  * tool_configurations: tool setting, not dynamic setting
  * tool_parameters: tool dynamic setting(by user)
  */
  const { provider_id, provider_type, tool_name, tool_configurations } = inputs
  const isBuiltIn = provider_type === CollectionType.builtIn
  const buildInTools = useStore(s => s.buildInTools)
  const customTools = useStore(s => s.customTools)
  const currentTools = isBuiltIn ? buildInTools : customTools
  const currCollection = currentTools.find(item => item.id === provider_id)

  // Auth
  const needAuth = !!currCollection?.allow_delete
  const isAuthed = !!currCollection?.is_team_authorization
  const isShowAuthBtn = isBuiltIn && needAuth && !isAuthed
  const [showSetAuth, {
    setTrue: showSetAuthModal,
    setFalse: hideSetAuthModal,
  }] = useBoolean(false)

  const handleSaveAuth = useCallback(async (value: any) => {
    await updateBuiltInToolCredential(currCollection?.name as string, value)

    Toast.notify({
      type: 'success',
      message: t('common.api.actionSuccess'),
    })
    handleFetchAllTools(provider_type)
    hideSetAuthModal()
  }, [currCollection?.name, hideSetAuthModal, t, handleFetchAllTools, provider_type])

  const currTool = currCollection?.tools.find(tool => tool.name === tool_name)
  const formSchemas = currTool ? toolParametersToFormSchemas(currTool.parameters) : []
  const toolInputVarSchema = formSchemas.filter((item: any) => item.form === 'llm')
  // use setting
  const toolSettingSchema = formSchemas.filter((item: any) => item.form !== 'llm')
  const toolSettingValue = (() => {
    return addDefaultValue(tool_configurations, toolSettingSchema)
  })()
  const setToolSettingValue = useCallback((value: Record<string, any>) => {
    setInputs({
      ...inputs,
      tool_configurations: value,
    })
  }, [inputs, setInputs])

  useEffect(() => {
    if (!currTool)
      return
    const inputsWithDefaultValue = produce(inputs, (draft) => {
      if (!draft.tool_configurations || Object.keys(draft.tool_configurations).length === 0)
        draft.tool_configurations = addDefaultValue(tool_configurations, toolSettingSchema)

      if (!draft.tool_parameters)
        draft.tool_parameters = {}
    })
    setInputs(inputsWithDefaultValue)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currTool])

  // setting when call
  const setInputVar = useCallback((value: ToolVarInputs) => {
    setInputs({
      ...inputs,
      tool_parameters: value,
    })
  }, [inputs, setInputs])

  const [currVarIndex, setCurrVarIndex] = useState(-1)
  const currVarType = toolInputVarSchema[currVarIndex]?._type
  const handleOnVarOpen = useCallback((index: number) => {
    setCurrVarIndex(index)
  }, [])

  const filterVar = useCallback((varPayload: Var) => {
    if (currVarType)
      return varPayload.type === currVarType

    return varPayload.type !== VarVarType.arrayFile
  }, [currVarType])

  const isLoading = currTool && (isBuiltIn ? !currCollection : false)

  // single run
  const [inputVarValues, doSetInputVarValues] = useState<Record<string, any>>({})
  const setInputVarValues = (value: Record<string, any>) => {
    doSetInputVarValues(value)
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
    setRunInputData(value)
  }
  // fill single run form variable with constant value first time
  const inputVarValuesWithConstantValue = () => {
    const res = produce(inputVarValues, (draft) => {
      Object.keys(inputs.tool_parameters).forEach((key: string) => {
        const { type, value } = inputs.tool_parameters[key]
        if (type === VarType.constant && (value === undefined || value === null))
          draft.tool_parameters[key].value = value
      })
    })
    return res
  }

  const {
    isShowSingleRun,
    hideSingleRun,
    getInputVars,
    runningStatus,
    setRunInputData,
    handleRun,
    handleStop,
    runResult,
  } = useOneStepRun<ToolNodeType>({
    id,
    data: inputs,
    defaultRunInputData: {},
    moreDataForCheckValid: {
      toolInputsSchema: [],
      toolSettingSchema,
      language,
    },
  })
  const hadVarParams = Object.keys(inputs.tool_parameters)
    .filter(key => inputs.tool_parameters[key].type !== VarType.constant)
    .map(k => inputs.tool_parameters[k])

  const varInputs = getInputVars(hadVarParams.map((p) => {
    if (p.type === VarType.variable)
      return `{{#${(p.value as ValueSelector).join('.')}#}}`

    return p.value as string
  }))

  const singleRunForms = (() => {
    const formInputs: InputVar[] = []
    toolInputVarSchema.forEach((item: any) => {
      formInputs.push({
        label: item.label[language] || item.label.en_US,
        variable: item.variable,
        type: item.type,
        required: item.required,
      })
    })
    const forms: FormProps[] = [{
      inputs: varInputs,
      values: inputVarValuesWithConstantValue(),
      onChange: setInputVarValues,
    }]
    return forms
  })()

  return {
    readOnly,
    inputs,
    currTool,
    toolSettingSchema,
    toolSettingValue,
    setToolSettingValue,
    toolInputVarSchema,
    setInputVar,
    handleOnVarOpen,
    filterVar,
    currCollection,
    isShowAuthBtn,
    showSetAuth,
    showSetAuthModal,
    hideSetAuthModal,
    handleSaveAuth,
    isLoading,
    isShowSingleRun,
    hideSingleRun,
    inputVarValues,
    varInputs,
    setInputVarValues,
    singleRunForms,
    runningStatus,
    handleRun,
    handleStop,
    runResult,
  }
}

export default useConfig
