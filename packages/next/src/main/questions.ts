import { listQuestions, retireQuestion, saveQuestion, type QuestionDefinition } from '@tradeanalyzer/core';
import { currentDb } from './generation.js';
import { operatorHost } from './operator.js';
import type { QuestionDefinitionDto, SavedQuestionDto } from '../shared/types.js';

/**
 * Saved questions — 05 §11.2, B9c. The rules and the storage are `core`'s; this
 * only carries them across the bridge, so a question saved here is validated by
 * the same code that runs it in the Data view.
 */

function toDto(q: ReturnType<typeof listQuestions>[number]): SavedQuestionDto {
  return {
    id: q.id,
    name: q.name,
    table: q.table,
    definition: q.definition as QuestionDefinitionDto,
    note: q.note,
    createdAt: q.createdAt
  };
}

export function questionsFor(table: string | null): readonly SavedQuestionDto[] {
  return listQuestions(currentDb() as never, table ?? undefined).map(toDto);
}

export function saveQuestionAs(
  name: string,
  table: string,
  definition: QuestionDefinitionDto,
  note: string | null
): SavedQuestionDto {
  return toDto(
    saveQuestion(currentDb() as never, operatorHost(), {
      name, table, definition: definition as QuestionDefinition, note
    })
  );
}

export function retireSavedQuestion(id: number): void {
  retireQuestion(currentDb() as never, operatorHost(), id);
}
