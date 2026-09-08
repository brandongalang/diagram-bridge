import { StepNode } from './StepNode.js';
import { DecisionNode } from './DecisionNode.js';
import { DatastoreNode } from './DatastoreNode.js';
import { TextNode } from './TextNode.js';
import { GroupNode } from './GroupNode.js';

export const nodeTypes = {
  step: StepNode,
  decision: DecisionNode,
  datastore: DatastoreNode,
  text: TextNode,
  group: GroupNode
};
