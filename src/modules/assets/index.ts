import groq from 'groq'
import produce from 'immer'
import {ofType, ActionsObservable} from 'redux-observable'
import {from, of, empty} from 'rxjs'
import {catchError, mergeAll, mergeMap, switchMap, withLatestFrom} from 'rxjs/operators'
import client from 'part:@sanity/base/client'

import {ORDERS} from '../../config'
import {
  Asset,
  BrowserOrder,
  BrowserFilter,
  BrowserView,
  DeleteHandleTarget,
  FetchOptions
} from '../../types'
import {AssetsActions, AssetsReducerState, AssetsDeleteRequestAction} from './types'

/***********
 * ACTIONS *
 ***********/

export enum AssetsActionTypes {
  CLEAR = 'ASSETS_CLEAR',
  DELETE_COMPLETE = 'ASSETS_DELETE_COMPLETE',
  DELETE_ERROR = 'ASSETS_DELETE_ERROR',
  DELETE_PICKED = 'ASSETS_DELETE_PICKED',
  DELETE_REQUEST = 'ASSETS_DELETE_REQUEST',
  FETCH_COMPLETE = 'ASSETS_FETCH_COMPLETE',
  FETCH_ERROR = 'ASSETS_FETCH_ERROR',
  FETCH_REQUEST = 'ASSETS_FETCH_REQUEST',
  LOAD_NEXT_PAGE = 'ASSETS_LOAD_NEXT_PAGE',
  LOAD_PAGE_INDEX = 'ASSETS_LOAD_PAGE_INDEX',
  PICK = 'ASSETS_PICK',
  PICK_ALL = 'ASSETS_PICK_ALL',
  PICK_CLEAR = 'ASSETS_PICK_CLEAR',
  SET_FILTER = 'ASSETS_SET_FILTER',
  SET_ORDER = 'ASSETS_SET_ORDER',
  SET_SEARCH_QUERY = 'ASSETS_SET_SEARCH_QUERY',
  SET_VIEW = 'ASSETS_SET_VIEW',
  UNCAUGHT_EXCEPTION = 'ASSETS_UNCAUGHT_EXCEPTION'
}

/***********
 * REDUCER *
 ***********/

/**
 * NOTE:
 * `fetchCount` returns the number of items retrieved in the most recent fetch.
 * This is a temporary workaround to be able to determine when there are no more items to retrieve.
 * Typically this would be done by deriving the total number of assets upfront, but currently such
 * queries in GROQ aren't fast enough to use on large datasets (1000s of entries).
 *
 * TODO:
 * When the query engine has been improved and above queries are faster, remove all instances of
 * of `fetchCount` and reinstate `totalCount` across the board.
 */

/**
 * `allIds` is an ordered array of all assetIds
 * `byIds` is an object literal that contains all normalised assets (with asset IDs as keys)
 */

export const initialState: AssetsReducerState = {
  allIds: [],
  byIds: {},
  fetchCount: -1,
  fetching: false,
  fetchingError: null,
  filter: undefined,
  filters: undefined,
  order: ORDERS[0],
  pageIndex: 0,
  pageSize: 50,
  searchQuery: '',
  view: 'grid'
  // totalCount: -1
}

export default function assetsReducerState(
  state: AssetsReducerState = initialState,
  action: AssetsActions
) {
  return produce(state, draft => {
    // eslint-disable-next-line default-case
    switch (action.type) {
      /**
       * Clear (not delete) all assets.
       * This is currently fired when changing browser filters / views, etc.
       * (May also be useful if we want more traditional paginated browsing, e.g going between pages
       * which doesn't persist content).
       */
      case AssetsActionTypes.CLEAR:
        draft.allIds = []
        draft.byIds = {}
        break

      /**
       * An asset has been successfully deleted via the client.
       * - Delete asset from the redux store (both the normalised object and ordered assetID).
       */
      case AssetsActionTypes.DELETE_COMPLETE: {
        const assetId = action.payload?.asset?._id
        const deleteIndex = draft.allIds.indexOf(assetId)
        draft.allIds.splice(deleteIndex, 1)
        delete draft.byIds[assetId]
        // draft.totalCount -= 1
        break
      }
      /**
       * An asset was unable to be deleted via the client.
       * - Store the error code on asset in question to optionally display to the user.
       * - Clear updating status on asset in question.
       */
      case AssetsActionTypes.DELETE_ERROR: {
        const assetId = action.payload?.asset?._id
        const errorCode = action.payload?.error?.statusCode
        draft.byIds[assetId].errorCode = errorCode
        draft.byIds[assetId].updating = false
        break
      }
      /**
       * A request to delete an asset has been made (and not yet completed).
       * - Set updating status on asset in question.
       * - Clear any existing asset errors
       */
      case AssetsActionTypes.DELETE_REQUEST: {
        const assetId = action.payload?.asset?._id
        draft.byIds[assetId].updating = true

        Object.keys(draft.byIds).forEach(key => {
          delete draft.byIds[key].errorCode
        })

        break
      }
      /**
       * A request to fetch assets has succeeded.
       * - Add all fetched assets as normalised objects, and store asset IDs in a separate ordered array.
       */
      case AssetsActionTypes.FETCH_COMPLETE: {
        const assets = action.payload?.assets || []
        // const totalCount = action.payload?.totalCount

        if (assets) {
          assets.forEach(asset => {
            draft.allIds.push(asset._id)
            draft.byIds[asset._id] = {
              asset: asset,
              picked: false,
              updating: false
            }
          })
        }

        draft.fetching = false
        draft.fetchCount = assets.length || 0
        draft.fetchingError = null
        // draft.totalCount = totalCount
        break
      }
      /**
       * A request to fetch assets has failed.
       * - Clear fetching status
       * - Store error status
       */
      case AssetsActionTypes.FETCH_ERROR: {
        draft.fetching = false
        draft.fetchingError = true
        break
      }

      /**
       * A request to fetch asset has been made (and not yet completed)
       * - Set fetching status
       * - Clear any previously stored error
       */
      case AssetsActionTypes.FETCH_REQUEST:
        draft.fetching = true
        draft.fetchingError = null
        break

      case AssetsActionTypes.LOAD_NEXT_PAGE:
        draft.pageIndex += 1
        break

      /**
       * An asset as 'picked' or 'checked' for batch operations.
       * (We don't use the word 'select' as that's reserved for the action of inserting an image into an entry).
       * - Set picked status for asset in question
       */
      case AssetsActionTypes.PICK: {
        const assetId = action.payload?.assetId
        const picked = action.payload?.picked

        draft.byIds[assetId].picked = picked
        break
      }
      /**
       * All assets have been picked.
       */
      case AssetsActionTypes.PICK_ALL:
        Object.keys(draft.byIds).forEach(key => {
          draft.byIds[key].picked = true
        })
        break
      /**
       * All assets have been unpicked.
       */
      case AssetsActionTypes.PICK_CLEAR:
        Object.keys(draft.byIds).forEach(key => {
          draft.byIds[key].picked = false
        })
        break

      case AssetsActionTypes.SET_FILTER:
        draft.filter = action.payload?.filter
        draft.pageIndex = 0
        break
      case AssetsActionTypes.SET_ORDER:
        draft.order = action.payload?.order
        draft.pageIndex = 0
        break
      case AssetsActionTypes.SET_SEARCH_QUERY:
        draft.searchQuery = action.payload?.searchQuery
        draft.pageIndex = 0
        break
      case AssetsActionTypes.SET_VIEW:
        draft.view = action.payload?.view
        break
    }
  })
}

/*******************
 * ACTION CREATORS *
 *******************/

// Clear all assets
export const assetsClear = () => ({
  type: AssetsActionTypes.CLEAR
})

// Delete started
export const assetsDelete = (asset: Asset, handleTarget: DeleteHandleTarget = 'snackbar') => ({
  payload: {
    asset,
    handleTarget
  },
  type: AssetsActionTypes.DELETE_REQUEST
})

// Delete success
export const assetsDeleteComplete = (asset: Asset) => ({
  payload: {
    asset
  },
  type: AssetsActionTypes.DELETE_COMPLETE
})

// Delete error
export const assetsDeleteError = (asset: Asset, error: any, handleTarget: DeleteHandleTarget) => ({
  payload: {
    asset,
    handleTarget,
    error
  },
  type: AssetsActionTypes.DELETE_ERROR
})

// Delete all picked assets
export const assetsDeletePicked = () => ({
  type: AssetsActionTypes.DELETE_PICKED
})

/**
 * Start fetch with constructed GROQ query
 *
 * @param {Object} [options]
 * @param {String} [options.filter] - GROQ filter
 * @param {Object} [options.params] - Params to pass to GROQ query (in `client.fetch`)
 * @param {String} [options.projections] - GROQ projections (must be wrapped in braces)
 * @param {String} [options.selector] - GROQ selector / range
 * @param {String} [options.sort] - GROQ sort
 */
export const assetsFetch = ({
  filter = groq`_type == "sanity.imageAsset"`,
  params = {},
  projections = groq`{
    _id,
    metadata {dimensions},
    originalFilename,
    url
  }`,
  selector = ``,
  sort = groq`order(_updatedAt desc)`
}: FetchOptions) => {
  const pipe = sort || selector ? '|' : ''

  // Construct query
  const query = groq`
    {
      "items": *[${filter}] ${projections} ${pipe} ${sort} ${selector},
    }
  `

  return {
    payload: {
      params,
      query
    },
    type: AssetsActionTypes.FETCH_REQUEST
  }
}

// Fetch complete
export const assetsFetchComplete = (
  assets: Asset[]
  // totalCount: number
) => ({
  payload: {
    assets
    // totalCount
  },
  type: AssetsActionTypes.FETCH_COMPLETE
})

// Fetch failed
export const assetsFetchError = (error: any) => ({
  payload: {
    error
  },
  type: AssetsActionTypes.FETCH_ERROR
})

// Load page assets at page index
export const assetsLoadPageIndex = (pageIndex: number) => ({
  payload: {
    pageIndex
  },
  type: AssetsActionTypes.LOAD_PAGE_INDEX
})

// Load next page
export const assetsLoadNextPage = () => ({
  type: AssetsActionTypes.LOAD_NEXT_PAGE
})

// Pick asset
export const assetsPick = (assetId: string, picked: boolean) => ({
  payload: {
    assetId,
    picked
  },
  type: AssetsActionTypes.PICK
})

// Pick all assets
export const assetsPickAll = () => ({
  type: AssetsActionTypes.PICK_ALL
})

// Unpick all assets
export const assetsPickClear = () => ({
  type: AssetsActionTypes.PICK_CLEAR
})

// Set view mode
export const assetsSetView = (view: BrowserView) => ({
  payload: {
    view
  },
  type: AssetsActionTypes.SET_VIEW
})

// Set filter
export const assetsSetFilter = (filter: BrowserFilter) => ({
  payload: {
    filter
  },
  type: AssetsActionTypes.SET_FILTER
})

// Set order
export const assetsSetOrder = (order: BrowserOrder) => ({
  payload: {
    order
  },
  type: AssetsActionTypes.SET_ORDER
})

// Set search query
export const assetsSetSearchQuery = (searchQuery: string) => ({
  payload: {
    searchQuery
  },
  type: AssetsActionTypes.SET_SEARCH_QUERY
})

/*********
 * EPICS *
 *********/

/**
 * List for asset delete requests:
 * - make async call to `client.delete`
 * - return a corresponding success or error action
 */
export const assetsDeleteEpic = (action$: ActionsObservable<AssetsDeleteRequestAction>) =>
  action$.pipe(
    ofType(AssetsActionTypes.DELETE_REQUEST),
    mergeMap(action => {
      return of(action).pipe(
        mergeMap(() => {
          const assetId = action.payload?.asset?._id
          return from(client.delete(assetId))
        }),
        mergeMap(() => {
          const asset = action.payload?.asset
          return of(assetsDeleteComplete(asset))
        }),
        catchError(error => {
          const asset = action.payload?.asset
          const handleTarget = action.payload?.handleTarget
          return of(assetsDeleteError(asset, error, handleTarget))
        })
      )
    })
  )

/**
 * Listen for requests to delete all picked assets:
 * - get all picked items not already in the process of updating
 * - invoke delete action creator for all INDIVIDUAL assets
 */
export const assetsDeletePickedEpic = (action$: any, state$: any) =>
  action$.pipe(
    ofType(AssetsActionTypes.DELETE_PICKED),
    withLatestFrom(state$),
    mergeMap(([, state]) => {
      const availableItems = Object.entries(state.assets.byIds).filter(([, value]: [any, any]) => {
        return value.picked && !value.updating
      })

      if (availableItems.length === 0) {
        return empty()
      }

      const assets = availableItems.map((item: any) => item[1].asset)
      return of(assets)
    }),
    mergeAll(),
    mergeMap((asset: any) => of(assetsDelete(asset, 'snackbar')))
  )

/**
 * Listen for fetch requests:
 * - make async call to `client.fetch`
 * - return a corresponding success or error action
 */
export const assetsFetchEpic = (action$: any) =>
  action$.pipe(
    ofType(AssetsActionTypes.FETCH_REQUEST),
    switchMap((action: any) => {
      return of(action).pipe(
        mergeMap(() => {
          const params = action.payload?.params
          const query = action.payload?.query
          return from(client.fetch(query, params))
        }),
        mergeMap((result: any) => {
          const {
            items
            // totalCount
          } = result

          return of(assetsFetchComplete(items))
        }),
        catchError(error => of(assetsFetchError(error)))
      )
    })
  )

/**
 * Listen for page load requests
 * - Fetch assets
 */
export const assetsFetchPageIndexEpic = (action$: any, state$: any) =>
  action$.pipe(
    ofType(AssetsActionTypes.LOAD_PAGE_INDEX),
    withLatestFrom(state$),
    switchMap(([action, state]) => {
      const pageSize = state.assets.pageSize
      const start = action.payload.pageIndex * pageSize
      const end = start + pageSize

      return of(
        assetsFetch({
          filter: constructFilter(state.assets.filter.value, state.assets.searchQuery),
          // Document ID can be null when operating on pristine / unsaved drafts
          ...(state?.document ? {params: {documentId: state?.document?._id}} : {}),
          projections: groq`{
            _id,
            _updatedAt,
            extension,
            metadata {
              dimensions,
              isOpaque,
            },
            originalFilename,
            size,
            url
          }`,
          selector: groq`[${start}...${end}]`,
          sort: groq`order(${state.assets.order.value})`
        })
      )
    })
  )

/**
 * Listen for changes to order, filter and search query
 * - Clear assets
 * - Load first page
 */
export const assetsFetchNextPageEpic = (action$: any, state$: any) =>
  action$.pipe(
    ofType(AssetsActionTypes.LOAD_NEXT_PAGE),
    withLatestFrom(state$),
    switchMap(([_, state]) => {
      return of(assetsLoadPageIndex(state.assets.pageIndex))
    })
  )

/**
 * Listen for order, filter and search query changes
 * - clear assets
 * - fetch first page
 */
export const assetsFetchPageEpic = (action$: any) =>
  action$.pipe(
    ofType(
      AssetsActionTypes.SET_ORDER,
      AssetsActionTypes.SET_FILTER,
      AssetsActionTypes.SET_SEARCH_QUERY
    ),
    switchMap(() => {
      return of(assetsClear(), assetsLoadPageIndex(0))
    })
  )

/*********
 * UTILS *
 *********/

/**
 * Construct GROQ filter based off custom search codes
 */
const constructFilter = (baseFilter: string, searchQuery?: string) => {
  let constructedQuery = groq`${baseFilter}`

  const REGEX_ORIENTATION = /orientation:(landscape|portrait|square)/i
  const REGEX_EXTENSION = /extension:([A-Za-z]*)/i

  if (searchQuery) {
    // Strip extension / orientation codes and trim whitespace
    const filenameQuery = searchQuery
      .replace(REGEX_ORIENTATION, '')
      .replace(REGEX_EXTENSION, '')
      .trim()

    // Append original filename search
    constructedQuery += groq` && originalFilename match '*${filenameQuery}*'`

    // Append orientation
    const orientation = searchQuery.match(REGEX_ORIENTATION)?.[1]

    if (orientation) {
      switch (orientation) {
        case 'landscape':
          constructedQuery += groq` && metadata.dimensions.aspectRatio > 1`
          break
        case 'portrait':
          constructedQuery += groq` && metadata.dimensions.aspectRatio < 1`
          break
        case 'square':
          constructedQuery += groq` && metadata.dimensions.aspectRatio == 1`
          break
        default:
          console.warn('Orientation must be of type (landscape | portrait | square)')
          break
      }
    }

    // Append file extension
    const extension = searchQuery.match(REGEX_EXTENSION)?.[1]
    if (extension) {
      constructedQuery += groq` && extension == '${extension}'`
    }
  }

  return constructedQuery
}
