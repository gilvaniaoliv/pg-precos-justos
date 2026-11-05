# Regras e Diretrizes do Projeto - P&G Preços Justos

## 🔄 Fluxo de Versão Git (Sincronização Obrigatória)

Para manter o repositório local e remoto (GitHub) sempre em perfeita sincronia:

1. **Antes de iniciar qualquer tarefa ou alteração de código:**
   - Executar `git pull --rebase origin main` para trazer as últimas atualizações do repositório remoto.
   - Garantir que a árvore local esteja limpa e alinhada antes de mexer em arquivos.

2. **Ao concluir uma tarefa, correção ou nova funcionalidade:**
   - Validar testes e funcionamento das alterações.
   - Executar `git add <arquivos>` relevantes.
   - Criar commit com mensagem clara e objetiva (preferencialmente seguindo o padrão Conventional Commits em português, ex: `feat:`, `fix:`, `style:`, `refactor:`).
   - Executar `git pull --rebase origin main` para evitar divergências.
   - Executar `git push origin main` para sincronizar imediatamente com o GitHub.
   - Informar o hash/resumo do commit e a confirmação do push ao usuário.
