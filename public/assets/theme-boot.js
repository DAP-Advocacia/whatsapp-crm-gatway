/*
 * Fase 0 do redesign — script de boot compartilhado (roda no <head>,
 * ANTES do primeiro paint, para nunca piscar o tema/paleta errados).
 * Espelha o comportamento do IIFE inline hoje duplicado em cada página
 * com sidebar (ver public/dashboard.html).
 *
 * Nesta fase o arquivo é linkado mas NÃO é a única fonte de verdade
 * ainda — as páginas continuam com o próprio bloco inline (que vence
 * por rodar depois, tarde o bastante, e por chamar a MESMA função só
 * que definida duas vezes). A migração de fato (apagar o bloco inline
 * de cada página e depender só deste arquivo) acontece na Fase 1, junto
 * da remoção da paleta personalizável — só então esta chamada dupla é
 * desfeita.
 */
if (localStorage.getItem('sidebarCollapsed') === '1') {
  document.documentElement.classList.add('sidebar-collapsed');
}
if (localStorage.getItem('theme') === 'light') {
  document.documentElement.setAttribute('data-theme', 'light');
}
