import { GraphQLError, Kind } from "graphql";

/**
 * Règle de validation GraphQL : champs racine d'une opération bornés.
 *
 * Le site et l'application mobile n'envoient qu'un champ racine par
 * opération. Sans borne, des alias permettaient de répéter une opération
 * des centaines de fois dans une seule requête HTTP (tentatives de mot de
 * passe d'un lien partagé, vérifications d'une adresse, calculs coûteux),
 * chacune n'étant comptée qu'une fois par la limite de débit.
 *
 * - au plus `maxRootFields` champs racine par opération ;
 * - un même champ racine au plus une fois (avec ou sans alias).
 * Les champs d'introspection (« __typename », « __schema »...) ne comptent
 * pas. Les fragments posés à la racine sont dépliés.
 */
export const MAX_ROOT_FIELDS = 10;

function collectRootFields(selectionSet, context, names, seenFragments) {
  for (const selection of selectionSet?.selections || []) {
    if (selection.kind === Kind.FIELD) {
      names.push(selection.name.value);
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      collectRootFields(selection.selectionSet, context, names, seenFragments);
    } else if (selection.kind === Kind.FRAGMENT_SPREAD) {
      const fragmentName = selection.name.value;
      if (seenFragments.has(fragmentName)) continue;
      seenFragments.add(fragmentName);
      const fragment = context.getFragment(fragmentName);
      if (fragment) {
        collectRootFields(
          fragment.selectionSet,
          context,
          names,
          seenFragments,
        );
      }
    }
  }
}

export function rootFieldLimitRule(maxRootFields = MAX_ROOT_FIELDS) {
  return (context) => ({
    OperationDefinition(node) {
      const names = [];
      collectRootFields(node.selectionSet, context, names, new Set());
      const counted = names.filter((name) => !name.startsWith("__"));

      if (counted.length > maxRootFields) {
        context.reportError(
          new GraphQLError(
            `Une opération ne peut pas demander plus de ${maxRootFields} champs à la fois.`,
            { nodes: [node] },
          ),
        );
        return;
      }

      const repeated = counted.find(
        (name, index) => counted.indexOf(name) !== index,
      );
      if (repeated) {
        context.reportError(
          new GraphQLError(
            `Le champ « ${repeated} » ne peut être demandé qu'une fois par opération.`,
            { nodes: [node] },
          ),
        );
      }
    },
  });
}
