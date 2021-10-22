import {
  mergeDeleteSets,
  iterateDeletedStructs,
  keepItem,
  transact,
  createID,
  redoItem,
  isParentOf,
  followRedone,
  getItemCleanStart,
  isDeleted,
  addToDeleteSet,
  Transaction, Doc, Item, GC, DeleteSet, AbstractType, YEvent // eslint-disable-line
} from '../internals.js'

import * as time from 'lib0/time'
import { Observable } from 'lib0/observable'

class StackItem {
  /**
   * @param {DeleteSet} deletions
   * @param {DeleteSet} insertions
   */
  constructor (undoManager, deletions, insertions) {
    this.undoManager = undoManager
    this.insertions = insertions
    this.deletions = deletions
    /**
     * Use this to save and restore metadata like selection range
     */
    this.meta = new Map()
  }

  undo() {

    /**
     * Whether a change happened
     * @type {StackItem?}
     */
    let result = null
    /**
     * Keep a reference to the transaction so we can fire the event with the changedParentTypes
     * @type {any}
     */
    let _tr = null
    const doc = this.undoManager.doc
    const scope = this.undoManager.scope
    transact(doc, transaction => {

      const store = doc.store
      const stackItem = /** @type {StackItem} */ this
      /**
       * @type {Set<Item>}
       */
      const itemsToRedo = new Set()
      /**
       * @type {Array<Item>}
       */
      const itemsToDelete = []
      let performedChange = false
      iterateDeletedStructs(transaction, stackItem.insertions, struct => {
        if (struct instanceof Item) {
          if (struct.redone !== null) {
            let { item, diff } = followRedone(store, struct.id)
            if (diff > 0) {
              item = getItemCleanStart(transaction, createID(item.id.client, item.id.clock + diff))
            }
            struct = item
          }
          if (!struct.deleted && scope.some(type => isParentOf(type, /** @type {Item} */ (struct)))) {
            itemsToDelete.push(struct)
          }
        }
      })
      iterateDeletedStructs(transaction, stackItem.deletions, struct => {
        if (
          struct instanceof Item &&
          scope.some(type => isParentOf(type, struct)) &&
          // Never redo structs in stackItem.insertions because they were created and deleted in the same capture interval.
          !isDeleted(stackItem.insertions, struct.id)
        ) {
          itemsToRedo.add(struct)
        }
      })
      itemsToRedo.forEach(struct => {
        performedChange = redoItem(transaction, struct, itemsToRedo, itemsToDelete) !== null || performedChange
      })
      // We want to delete in reverse order so that children are deleted before
      // parents, so we have more information available when items are filtered.
      for (let i = itemsToDelete.length - 1; i >= 0; i--) {
        const item = itemsToDelete[i]
        if (this.undoManager.deleteFilter(item)) {
          item.delete(transaction)
          performedChange = true
        }
      }

      result = performedChange ? stackItem : null

      transaction.changed.forEach((subProps, type) => {
        // destroy search marker if necessary
        if (subProps.has(null) && type._searchMarker) {
          type._searchMarker.length = 0
        }
      })
      _tr = transaction
    }, this.undoManager);

    return {
      result,
      transaction: _tr
    }

  }

  redo() {

    /**
     * Ideally we'd implement a redo here so we don't have to derive undo
     * stack items from observing undo transactions. 
     * 
     * That way we can keep the stackItems in memory and preserve meta data
     * 
     */

  }

  merge(deletions, insertions) {

    this.deletions = mergeDeleteSets([this.deletions, deletions])
    this.insertions = mergeDeleteSets([this.insertions, insertions])

  }

  destroy(transaction) {

    iterateDeletedStructs(transaction, stackItem.deletions, item => {
      if (item instanceof Item && this.scope.some(type => isParentOf(type, item))) {
        keepItem(item, false)
      }
    })

  }
}

/**
 * @typedef {Object} UndoManagerOptions
 * @property {number} [UndoManagerOptions.captureTimeout=500]
 * @property {function(Item):boolean} [UndoManagerOptions.deleteFilter=()=>true] Sometimes
 * it is necessary to filter whan an Undo/Redo operation can delete. If this
 * filter returns false, the type/item won't be deleted even it is in the
 * undo/redo scope.
 * @property {Set<any>} [UndoManagerOptions.trackedOrigins=new Set([null])]
 */

/**
 * Fires 'stack-item-added' event when a stack item was added to either the undo- or
 * the redo-stack. You may store additional stack information via the
 * metadata property on `event.stackItem.meta` (it is a `Map` of metadata properties).
 * Fires 'stack-item-popped' event when a stack item was popped from either the
 * undo- or the redo-stack. You may restore the saved stack information from `event.stackItem.meta`.
 *
 * @extends {Observable<'stack-item-added'|'stack-item-popped'>}
 */
export class UndoManager extends Observable {
  /**
   * @param {AbstractType<any>|Array<AbstractType<any>>} typeScope Accepts either a single type, or an array of types
   * @param {UndoManagerOptions} options
   */
  constructor (typeScope, { captureTimeout = 500, deleteFilter = () => true, trackedOrigins, ignoredOrigins } = {}) {
    super()
    this.scope = typeScope instanceof Array ? typeScope : [typeScope]
    this.deleteFilter = deleteFilter

    this.trackedOrigins = trackedOrigins
    this.ignoredOrigins = ignoredOrigins

    // Preserve existing default behavior
    if(this.trackedOrigins && this.ignoredOrigins) {
      throw 'Cannot mix trackedOrigins and ignoredOrigins options'
    }

    if(this.trackedOrigins) {
      this.trackedOrigins.add(this);
      this.trackedOrigins.add(null);
    }

    /**
     * @type {Array<StackItem>}
     */
    this.undoStack = []
    /**
     * @type {Array<StackItem>}
     */
    this.redoStack = []
    /**
     * Whether the client is currently undoing (calling UndoManager.undo)
     *
     * @type {boolean}
     */
    this.undoing = false
    this.redoing = false
    this.doc = /** @type {Doc} */ (this.scope[0].doc)
    this.lastChange = 0
    this.doc.on('afterTransaction', /** @param {Transaction} transaction */ transaction => {
      // Only track certain transactions
       // if this undoManager is disconnected or the transaction is not within the scope of this undoManager
      if(this.disconnected || !this.scope.some(type => transaction.changedParentTypes.has(type))) {
        return
      }

      // if trackedOrigins is passed, only listen to changes originating from this this.trackedOrigins
      if (this.trackedOrigins && !this.trackedOrigins.has(transaction.origin) && (!transaction.origin || !this.trackedOrigins.has(transaction.origin.constructor))) {
        //console.log('trackedOrigins hit', transaction)
        return
      }

      // if ignoredOrigins is passed, only listen to changes _not_ originating from this this.ignoredOrigins
      if (this.ignoredOrigins && (this.ignoredOrigins.has(transaction.origin) || (transaction.origin && this.ignoredOrigins.has(transaction.origin.constructor)))) {
        //console.log('ignoredOrigins hit', transaction)
        return
      }

      const undoing = this.undoing
      const redoing = this.redoing
      const stack = undoing ? this.redoStack : this.undoStack
      if (undoing) {
        this.stopCapturing() // next undo should not be appended to last stack item
      } else if (!redoing) {
        // neither undoing nor redoing: delete redoStack
        this.redoStack = []
      }
      const insertions = new DeleteSet()
      transaction.afterState.forEach((endClock, client) => {
        const startClock = transaction.beforeState.get(client) || 0
        const len = endClock - startClock
        if (len > 0) {
          addToDeleteSet(insertions, client, startClock, len)
        }
      })
      const now = time.getUnixTime()
      if (now - this.lastChange < captureTimeout && stack.length > 0 && !undoing && !redoing) {
        // append change to last stack op
        stack[stack.length - 1].merge(transaction.deleteSet, insertions);
      } else {
        // create a new stack op
        stack.push(new StackItem(this, transaction.deleteSet, insertions))
      }
      if (!undoing && !redoing) {
        this.lastChange = now
      }
      // make sure that deleted structs are not gc'd
      iterateDeletedStructs(transaction, transaction.deleteSet, /** @param {Item|GC} item */ item => {
        if (item instanceof Item && this.scope.some(type => isParentOf(type, item))) {
          keepItem(item, true)
        }
      })
      this.emit('stack-item-added', [{ stackItem: stack[stack.length - 1], origin: transaction.origin, type: undoing ? 'redo' : 'undo', changedParentTypes: transaction.changedParentTypes }, this])
    })
  }

  clear () {
    this.doc.transact(transaction => {
      this.undoStack.forEach(stackItem => stackItem.destroy(transaction))
      this.redoStack.forEach(stackItem => stackItem.destroy(transaction))
    })
    this.undoStack = []
    this.redoStack = []
  }

  /**
   * UndoManager merges Undo-StackItem if they are created within time-gap
   * smaller than `options.captureTimeout`. Call `um.stopCapturing()` so that the next
   * StackItem won't be merged.
   *
   *
   * @example
   *     // without stopCapturing
   *     ytext.insert(0, 'a')
   *     ytext.insert(1, 'b')
   *     um.undo()
   *     ytext.toString() // => '' (note that 'ab' was removed)
   *     // with stopCapturing
   *     ytext.insert(0, 'a')
   *     um.stopCapturing()
   *     ytext.insert(0, 'b')
   *     um.undo()
   *     ytext.toString() // => 'a' (note that only 'b' was removed)
   *
   */
  stopCapturing () {
    this.lastChange = 0
  }

  /**
   * Undo last changes on type.
   *
   * @return {StackItem?} Returns StackItem if a change was applied
   */
  undo () {
    this.undoing = true

    let result = null;
    let transaction;

    try {

      while (this.undoStack.length > 0 && result === null) {
        ({ result, transaction } = (this.undoStack.pop())?.undo())
      }

      if (result != null) {
        const changedParentTypes = transaction.changedParentTypes
        this.emit('stack-item-popped', [{ stackItem: result, type: 'undo', changedParentTypes }, this])
      }

    } finally {
      this.undoing = false
    }
    return result
  }

  /**
   * Redo last undo operation.
   *
   * @return {StackItem?} Returns StackItem if a change was applied
   */
  redo () {
    this.redoing = true

    let result = null;
    let transaction;

    try {
      while (this.redoStack.length > 0 && result === null) {
        ({ result, transaction } = (this.redoStack.pop())?.undo())
      }

      if (result != null) {
        const changedParentTypes = transaction.changedParentTypes
        this.emit('stack-item-popped', [{ stackItem: result, type: 'redo', changedParentTypes }, this])
      }

    } finally {
      this.redoing = false
    }
    return result
  }
}
