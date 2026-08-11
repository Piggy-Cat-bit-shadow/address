import type { Locale } from './types';

export interface FavoritesCopy {
  title: string; count: string; save: string; saved: string; remove: string; removed: string; back: string;
  groupBy: string; byContinent: string; byCountry: string; allContinents: string; allCountries: string;
  filterContinent: string; filterCountry: string; empty: string; noResults: string; temporary: string;
  position: string; move: string; drag: string; copy: string; copied: string; copyFailed: string; undo: string; openGoogle: string; openAmap: string;
}

const base: FavoritesCopy = {
  title: 'Saved addresses', count: 'saved addresses', save: 'Save address', saved: 'Address saved', remove: 'Remove', removed: 'Address removed', back: 'Back to generator',
  groupBy: 'Group by', byContinent: 'Continent', byCountry: 'Country', allContinents: 'All continents', allCountries: 'All countries',
  filterContinent: 'Filter by continent', filterCountry: 'Filter by country', empty: 'No saved addresses yet.', noResults: 'No saved addresses match these filters.',
  temporary: 'Browser storage is unavailable. Changes will last for this tab only.', position: 'Position', move: 'Move', drag: 'Drag to reorder', copy: 'Copy', copied: 'Copied', copyFailed: 'Copy failed', undo: 'Undo', openGoogle: 'Google Maps', openAmap: 'AMap'
};

export const favoritesCopy: Record<Locale, FavoritesCopy> = {
  en: base,
  'zh-CN': {
    title: '地址收藏', count: '个收藏地址', save: '收藏地址', saved: '地址已收藏', remove: '删除', removed: '地址已删除', back: '返回生成器',
    groupBy: '分组方式', byContinent: '按大洲', byCountry: '按国家', allContinents: '全部大洲', allCountries: '全部国家',
    filterContinent: '按大洲筛选', filterCountry: '按国家筛选', empty: '还没有收藏地址。', noResults: '没有符合筛选条件的收藏地址。',
    temporary: '浏览器存储不可用，本次修改只在当前标签页保留。', position: '序号', move: '移动', drag: '拖动调整顺序', copy: '复制', copied: '已复制', copyFailed: '复制失败', undo: '撤销', openGoogle: '谷歌地图', openAmap: '高德地图'
  },
  'zh-TW': {
    title: '地址收藏', count: '個收藏地址', save: '收藏地址', saved: '地址已收藏', remove: '刪除', removed: '地址已刪除', back: '返回產生器',
    groupBy: '分組方式', byContinent: '按大洲', byCountry: '按國家', allContinents: '全部大洲', allCountries: '全部國家',
    filterContinent: '按大洲篩選', filterCountry: '按國家篩選', empty: '尚未收藏地址。', noResults: '沒有符合篩選條件的收藏地址。',
    temporary: '瀏覽器儲存空間不可用，本次修改只保留於目前分頁。', position: '序號', move: '移動', drag: '拖曳調整順序', copy: '複製', copied: '已複製', copyFailed: '複製失敗', undo: '復原', openGoogle: 'Google 地圖', openAmap: '高德地圖'
  },
  ja: { ...base, title: '保存した住所', count: '件の保存住所', save: '住所を保存', saved: '住所を保存しました', remove: '削除', removed: '住所を削除しました', back: 'ジェネレーターに戻る', groupBy: 'グループ', byContinent: '大陸別', byCountry: '国別', allContinents: 'すべての大陸', allCountries: 'すべての国', filterContinent: '大陸で絞り込み', filterCountry: '国で絞り込み', empty: '保存した住所はありません。', noResults: '条件に一致する住所はありません。', position: '順番', move: '移動', drag: 'ドラッグして並べ替え', copy: 'コピー', copied: 'コピー済み', copyFailed: 'コピーに失敗しました', undo: '元に戻す' },
  ko: { ...base, title: '저장한 주소', count: '개의 저장된 주소', save: '주소 저장', saved: '주소가 저장되었습니다', remove: '삭제', removed: '주소가 삭제되었습니다', back: '생성기로 돌아가기', groupBy: '그룹 기준', byContinent: '대륙', byCountry: '국가', allContinents: '모든 대륙', allCountries: '모든 국가', filterContinent: '대륙 필터', filterCountry: '국가 필터', empty: '저장한 주소가 없습니다.', noResults: '필터와 일치하는 주소가 없습니다.', position: '순서', move: '이동', drag: '드래그하여 순서 변경', copy: '복사', copied: '복사됨', copyFailed: '복사하지 못했습니다', undo: '실행 취소' },
  de: { ...base, title: 'Gespeicherte Adressen', count: 'gespeicherte Adressen', save: 'Adresse speichern', saved: 'Adresse gespeichert', remove: 'Entfernen', removed: 'Adresse entfernt', back: 'Zurueck zum Generator', groupBy: 'Gruppieren nach', byContinent: 'Kontinent', byCountry: 'Land', allContinents: 'Alle Kontinente', allCountries: 'Alle Laender', filterContinent: 'Kontinent filtern', filterCountry: 'Land filtern', empty: 'Noch keine Adressen gespeichert.', noResults: 'Keine gespeicherten Adressen entsprechen den Filtern.', position: 'Position', move: 'Verschieben', drag: 'Zum Sortieren ziehen', copy: 'Kopieren', copied: 'Kopiert', copyFailed: 'Kopieren fehlgeschlagen', undo: 'Rueckgaengig' },
  fr: { ...base, title: 'Adresses enregistrees', count: 'adresses enregistrees', save: "Enregistrer l'adresse", saved: 'Adresse enregistree', remove: 'Supprimer', removed: 'Adresse supprimee', back: 'Retour au generateur', groupBy: 'Regrouper par', byContinent: 'Continent', byCountry: 'Pays', allContinents: 'Tous les continents', allCountries: 'Tous les pays', filterContinent: 'Filtrer par continent', filterCountry: 'Filtrer par pays', empty: 'Aucune adresse enregistree.', noResults: 'Aucune adresse ne correspond aux filtres.', position: 'Position', move: 'Deplacer', drag: 'Faire glisser pour reordonner', copy: 'Copier', copied: 'Copie', copyFailed: 'Echec de la copie', undo: 'Annuler' },
  es: { ...base, title: 'Direcciones guardadas', count: 'direcciones guardadas', save: 'Guardar direccion', saved: 'Direccion guardada', remove: 'Eliminar', removed: 'Direccion eliminada', back: 'Volver al generador', groupBy: 'Agrupar por', byContinent: 'Continente', byCountry: 'Pais', allContinents: 'Todos los continentes', allCountries: 'Todos los paises', filterContinent: 'Filtrar por continente', filterCountry: 'Filtrar por pais', empty: 'Aun no hay direcciones guardadas.', noResults: 'Ninguna direccion coincide con los filtros.', position: 'Posicion', move: 'Mover', drag: 'Arrastrar para ordenar', copy: 'Copiar', copied: 'Copiado', copyFailed: 'Error al copiar', undo: 'Deshacer' },
  pt: { ...base, title: 'Enderecos salvos', count: 'enderecos salvos', save: 'Salvar endereco', saved: 'Endereco salvo', remove: 'Remover', removed: 'Endereco removido', back: 'Voltar ao gerador', groupBy: 'Agrupar por', byContinent: 'Continente', byCountry: 'Pais', allContinents: 'Todos os continentes', allCountries: 'Todos os paises', filterContinent: 'Filtrar por continente', filterCountry: 'Filtrar por pais', empty: 'Nenhum endereco salvo.', noResults: 'Nenhum endereco corresponde aos filtros.', position: 'Posicao', move: 'Mover', drag: 'Arraste para reordenar', copy: 'Copiar', copied: 'Copiado', copyFailed: 'Falha ao copiar', undo: 'Desfazer' }
};
