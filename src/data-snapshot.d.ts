import { DataReference } from './data-reference';

export class DataSnapshot {
    /**
     * Reference to the node
     */
    ref:DataReference

    /**
     * Gets the value stored in the referenced path, or null if it did't exist in the database. NOTE: In "child_removed" event subscription callbacks, this contains the removed child value instead.
     */
    val(): any

    /**
     * If this snapshot is returned in an event subscription callback (eg "child_changed" or "mutated" event), this contains the previous value of the referenced path that was stored in the database.
     */
    previous(): any

    /**
     * Indicates whether the node exists in the database
     */
    exists(): boolean

    /**
     * The key of the node's path
     */
    key: string|number

    /**
     * Gets a new snapshot for a child node
     * @param path child key or path
     */
    child(path: string): DataSnapshot

    /**
     * Checks if the snapshot's value has a child with the given key or path
     * @param path child key or path
     */
    hasChild(path: string): boolean

    /**
     * Indicates whether the the snapshot's value has any child nodes
     */
    hasChildren(): boolean

    /**
     * The number of child nodes in this snapshot
     */
    numChildren(): number

    /**
     * Runs a callback function for each child node in this snapshot until the callback returns false
     * @param action callback function that is called with a snapshot of each child node in this snapshot. Must return a boolean value that indicates whether to continue iterating or not.
     */
    forEach(action: (child: DataSnapshot) => boolean): void
}