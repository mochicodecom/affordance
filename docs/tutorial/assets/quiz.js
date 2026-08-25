/* Quiz widget shared by all lessons.
 *
 * Usage in a lesson (tags spelled with a spaced slash so this comment
 * survives being inlined into an HTML <script> block):
 *   <div id="quiz"></div>
 *   <script src="../assets/quiz.js">< /script>
 *   <script>
 *     renderQuiz(document.getElementById('quiz'), [
 *       { q: 'Question text?',
 *         choices: ['A', 'B', 'C', 'D'],
 *         answer: 2,                       // index into choices
 *         explain: 'Shown after answering.' },
 *     ])
 *   < /script>
 *
 * Feedback is immediate: click a choice, it locks, correct/wrong is shown,
 * and the explanation appears. No score, no persistence — retrieval practice.
 */
'use strict'

function renderQuiz(container, questions) {
  container.classList.add('quiz')
  questions.forEach(function (question, index) {
    const box = document.createElement('div')
    box.className = 'quiz-question'

    const heading = document.createElement('h4')
    heading.textContent = index + 1 + '. ' + question.q
    box.appendChild(heading)

    const buttons = []
    question.choices.forEach(function (choice, choiceIndex) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'quiz-choice'
      button.textContent = choice
      button.addEventListener('click', function () {
        buttons.forEach(function (b) {
          b.disabled = true
        })
        buttons[question.answer].classList.add('is-correct')
        if (choiceIndex !== question.answer) button.classList.add('is-wrong')
        if (question.explain) {
          const explain = document.createElement('p')
          explain.className = 'quiz-explain'
          explain.textContent = question.explain
          box.appendChild(explain)
        }
      })
      buttons.push(button)
      box.appendChild(button)
    })

    container.appendChild(box)
  })
}
